"""
Детекция таблиц и графиков на слайде + извлечение переиспользуемого профиля стиля.

Три источника контента:
  - нативная PPT-таблица (shape.has_table)                      -> content_type=table,  source_kind=native
  - имитация таблицы текстовыми блоками, выстроенными в сетку   -> content_type=table,  source_kind=imitation
  - нативный PPT-график (shape.has_chart)                       -> content_type=chart,  source_kind=native
  - картинка, эвристически похожая на график (OpenCV)           -> content_type=chart,  source_kind=image

Возвращает список тегов на слайд: [{shape_index, content_type, source_kind,
chart_type, label, style_payload, confidence}, ...]. Не бросает исключений наружу —
при сбое анализа конкретного shape просто пропускает его (сама детекция не должна
ломать основной анализ текста презентации).

style_payload — полный извлечённый профиль стиля (цвета, шрифты, границы, признаки
изображения и т.д.), пригодный для последующей генерации похожих таблиц/графиков.
label — короткая сводка на одну строку (для списков/поиска). Подробное
человекочитаемое описание для UI (клик по бейджу) строится на фронтенде из
style_payload — см. public/js/modules/fileList.js: styleDetailsFromTag().
"""
import io
import math
import re
import zipfile
from collections import defaultdict
from xml.etree import ElementTree as ET

try:
    import numpy as np
    import cv2
    _CV2_AVAILABLE = True
except Exception:
    _CV2_AVAILABLE = False

EMU_PER_PT = 12700

A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main'
C_NS = 'http://schemas.openxmlformats.org/drawingml/2006/chart'
R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
NSMAP = {'a': A_NS, 'c': C_NS, 'r': R_NS}


def _a(tag):
    return f'{{{A_NS}}}{tag}'


def _c(tag):
    return f'{{{C_NS}}}{tag}'


# ---------------------------------------------------------------------------
# Общие помощники извлечения цвета/шрифта через python-pptx object model
# ---------------------------------------------------------------------------

def _safe_rgb(color_format):
    """Возвращает '#RRGGBB' из ColorFormat, либо None, если цвет не задан явно (тема/наследование)."""
    try:
        if color_format is None:
            return None
        if color_format.type is None:
            return None
        rgb = color_format.rgb
        return f'#{rgb}' if rgb else None
    except Exception:
        return None


def _fill_color(fill):
    try:
        if fill is None or fill.type is None:
            return None
        return _safe_rgb(fill.fore_color)
    except Exception:
        return None


def _font_summary(font):
    try:
        return {
            'name': font.name,
            'size': font.size.pt if font.size else None,
            'bold': bool(font.bold) if font.bold is not None else None,
            'italic': bool(font.italic) if font.italic is not None else None,
            'color': _safe_rgb(font.color) if font.color else None,
        }
    except Exception:
        return {}


def _fmt_font(font):
    """Короткая читаемая запись шрифта: 'Calibri 18pt, полужирный, #FFFFFF'."""
    if not font or not font.get('name'):
        return None
    parts = [font['name']]
    if font.get('size'):
        parts.append(f"{font['size']:.0f}pt")
    extra = []
    if font.get('bold'):
        extra.append('полужирный')
    if font.get('italic'):
        extra.append('курсив')
    if font.get('color'):
        extra.append(font['color'])
    text = ' '.join(parts)
    if extra:
        text += ', ' + ', '.join(extra)
    return text


# ---------------------------------------------------------------------------
# Разрешение цветов темы (schemeClr) для случаев, когда стиль задан ссылкой на
# тему/tableStyle, а не явным RGB — то есть в подавляющем большинстве реальных
# презентаций, использующих встроенные стили PowerPoint.
# ---------------------------------------------------------------------------

def _theme_partname_for_master(pptx_zip, master_partname):
    """Читает .rels файл slideMaster'а из архива и возвращает путь до его theme-части.
    Не полагается на python-pptx `theme_part` (атрибут отсутствует в текущей версии),
    читает связи напрямую из OPC-архива."""
    master_partname = master_partname.lstrip('/')
    dir_name = master_partname.rsplit('/', 1)[0] if '/' in master_partname else ''
    file_name = master_partname.rsplit('/', 1)[-1]
    rels_path = f'{dir_name}/_rels/{file_name}.rels' if dir_name else f'_rels/{file_name}.rels'
    try:
        rels_data = pptx_zip.read(rels_path)
    except KeyError:
        return None
    try:
        root = ET.fromstring(rels_data)
    except Exception:
        return None
    for rel in root:
        if rel.get('Type', '').endswith('/theme'):
            target = rel.get('Target')
            if not target:
                continue
            if target.startswith('/'):
                return target.lstrip('/')
            # цели относительны к папке с master-частью (обычно '../theme/themeN.xml')
            base_dir = dir_name
            parts = base_dir.split('/') if base_dir else []
            for segment in target.split('/'):
                if segment == '..':
                    if parts:
                        parts.pop()
                elif segment != '.':
                    parts.append(segment)
            return '/'.join(parts)
    return None


def _load_theme_colors(pptx_zip, slide_part):
    """Строит словарь {schemeClr name -> '#RRGGBB'} для темы, применённой к слайду,
    читая theme XML напрямую из архива (slide -> slideLayout -> slideMaster -> theme через
    партнейм python-pptx и реальные .rels из архива, а не через атрибут theme_part,
    которого нет в текущей версии python-pptx)."""
    try:
        master_partname = str(slide_part.slide_layout.slide_master.part.partname)
        theme_partname = _theme_partname_for_master(pptx_zip, master_partname)
        if not theme_partname:
            return {}
        theme_data = pptx_zip.read(theme_partname)
        theme_root = ET.fromstring(theme_data)
        color_map = {}
        clr_scheme = theme_root.find(f'.//{_a("clrScheme")}')
        if clr_scheme is None:
            return {}
        # Порядок схемных слотов важен для отображения dk1/lt1/dk2/lt2 -> tx1/bg1/tx2/bg2
        slot_order = ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3',
                      'accent4', 'accent5', 'accent6', 'hlink', 'folHlink']
        for slot in slot_order:
            node = clr_scheme.find(_a(slot))
            if node is None:
                continue
            rgb = _color_node_to_rgb(node)
            if rgb:
                color_map[slot] = rgb
        # Альтернативные имена, которыми на слайд ссылаются на dk1/lt1 и т.д.
        alias = {'tx1': 'dk1', 'bg1': 'lt1', 'tx2': 'dk2', 'bg2': 'lt2'}
        for alias_name, target in alias.items():
            if target in color_map:
                color_map[alias_name] = color_map[target]
        return color_map
    except Exception:
        return {}


def _color_node_to_rgb(node):
    """Из <a:srgbClr val="RRGGBB"/> или <a:sysClr .../> достаёт '#RRGGBB'."""
    try:
        child = list(node)[0] if len(list(node)) else None
        if child is None:
            return None
        tag = child.tag.split('}')[-1]
        if tag == 'srgbClr':
            val = child.get('val')
            return f'#{val.upper()}' if val else None
        if tag == 'sysClr':
            val = child.get('lastClr')
            return f'#{val.upper()}' if val else None
    except Exception:
        pass
    return None


def _resolve_scheme_color(el, theme_colors):
    """Ищет <a:schemeClr val="accentN"/> внутри el и резолвит через theme_colors."""
    if el is None:
        return None
    scheme = el.find(_a('schemeClr'))
    if scheme is not None:
        val = scheme.get('val')
        return theme_colors.get(val)
    srgb = el.find(_a('srgbClr'))
    if srgb is not None:
        val = srgb.get('val')
        return f'#{val.upper()}' if val else None
    return None


def _fill_rgb_from_element(fill_el, theme_colors):
    """<a:solidFill> -> RGB, с учётом schemeClr/srgbClr."""
    if fill_el is None:
        return None
    solid = fill_el if fill_el.tag == _a('solidFill') else fill_el.find(_a('solidFill'))
    if solid is None:
        return None
    return _resolve_scheme_color(solid, theme_colors)


# ---------------------------------------------------------------------------
# Таблицы: разрешение стиля таблицы (tableStyles.xml) для случаев, когда ячейки
# не имеют явной заливки, а используют referenced tableStyleId (подавляющее
# большинство таблиц, созданных штатными средствами PowerPoint).
# ---------------------------------------------------------------------------

def _load_table_styles(pptx_zip, theme_colors):
    """Парсит ppt/tableStyles.xml -> {styleId: {slot: {'fill': rgb_or_none, 'textColor': rgb_or_none, 'bold': bool}}}."""
    try:
        data = pptx_zip.read('ppt/tableStyles.xml')
    except KeyError:
        return {}
    try:
        root = ET.fromstring(data)
    except Exception:
        return {}
    styles = {}
    for style_el in root.findall(_a('tblStyle')):
        style_id = style_el.get('styleId')
        slots = {}
        for slot_el in style_el:
            slot_name = slot_el.tag.split('}')[-1]
            tc_style = slot_el.find(_a('tcStyle'))
            tc_tx_style = slot_el.find(_a('tcTxStyle'))
            fill_rgb = None
            if tc_style is not None:
                fill_el = tc_style.find(_a('fill'))
                if fill_el is not None:
                    fill_rgb = _fill_rgb_from_element(fill_el, theme_colors or {})
            text_color = None
            bold = None
            if tc_tx_style is not None:
                scheme = tc_tx_style.find(_a('schemeClr'))
                if scheme is not None:
                    text_color = scheme.get('val')  # резолвим позже через theme_colors
                bold = tc_tx_style.get('b') == 'on'
            slots[slot_name] = {'fill': fill_rgb, 'textColorSlot': text_color, 'bold': bold}
        styles[style_id] = slots
    return styles


def _resolve_table_style_colors(slots, theme_colors):
    """Резолвит textColorSlot (имя schemeClr) в RGB через theme_colors, отдаёт копию."""
    resolved = {}
    for slot_name, info in slots.items():
        fill = info.get('fill')
        text_slot = info.get('textColorSlot')
        text_color = theme_colors.get(text_slot) if text_slot else None
        resolved[slot_name] = {'fill': fill, 'textColor': text_color, 'bold': info.get('bold')}
    return resolved


def _table_style_summary(tbl_pr_el, table_styles, theme_colors):
    """Возвращает читаемое резюме применённого стиля таблицы по её tblPr:
    {styleId, headerFill, headerTextColor, headerBold, bandFill, bandRow, bandCol,
     firstRow, firstCol}."""
    if tbl_pr_el is None:
        return None
    style_id_el = tbl_pr_el.find(_a('tableStyleId'))
    style_id = style_id_el.text.strip() if style_id_el is not None and style_id_el.text else None
    band_row = tbl_pr_el.get('bandRow') == '1'
    band_col = tbl_pr_el.get('bandCol') == '1'
    first_row = tbl_pr_el.get('firstRow') == '1'
    first_col = tbl_pr_el.get('firstCol') == '1'

    slots = table_styles.get(style_id, {}) if style_id else {}
    resolved = _resolve_table_style_colors(slots, theme_colors)

    whole = resolved.get('wholeTbl', {})
    first_row_style = resolved.get('firstRow', {})
    band1h = resolved.get('band1H', {})

    return {
        'styleId': style_id,
        'baseFill': whole.get('fill'),
        'headerFill': first_row_style.get('fill') if first_row else None,
        'headerTextColor': first_row_style.get('textColor') if first_row else None,
        'headerBold': first_row_style.get('bold') if first_row else None,
        'bandFill': band1h.get('fill') if band_row else None,
        'bandRow': band_row,
        'bandCol': band_col,
        'firstRow': first_row,
        'firstCol': first_col,
    }


def _cell_explicit_fill(tc_el, theme_colors):
    """Явная заливка конкретной ячейки (a:tcPr/a:solidFill), если задана поверх стиля таблицы."""
    if tc_el is None:
        return None
    tc_pr = tc_el.find(_a('tcPr'))
    if tc_pr is None:
        return None
    solid = tc_pr.find(_a('solidFill'))
    if solid is None:
        return None
    return _resolve_scheme_color(solid, theme_colors)


def _cell_borders(tc_el):
    """Есть ли явно заданные видимые границы у ячейки (используется для borders_visible)."""
    if tc_el is None:
        return None
    tc_pr = tc_el.find(_a('tcPr'))
    if tc_pr is None:
        return None
    for side in ('lnL', 'lnR', 'lnT', 'lnB'):
        ln = tc_pr.find(_a(side))
        if ln is not None and ln.find(_a('noFill')) is None:
            return True
    return False


def _analyze_native_table(shape, shape_index, table_styles, theme_colors):
    table = shape.table
    n_rows = len(table.rows)
    n_cols = len(table.columns)
    tbl_el = table._tbl
    tbl_pr_el = tbl_el.find(_a('tblPr'))

    applied_style = _table_style_summary(tbl_pr_el, table_styles, theme_colors)

    # Явные заливки/шрифты по образцовым ячейкам: заголовок (0,0), тело (1,0),
    # плюс проверка чётной строки (для band-таблиц), если строк достаточно.
    header_fill = None
    header_font = {}
    body_fill = None
    body_font = {}
    band_fill_observed = None
    borders_visible = None

    try:
        rows_el = tbl_el.findall(_a('tr'))
        if n_rows > 0:
            header_cell = table.cell(0, 0)
            tc_el_0 = rows_el[0].findall(_a('tc'))[0] if rows_el else None
            header_fill = _cell_explicit_fill(tc_el_0, theme_colors) or (applied_style or {}).get('headerFill')
            if header_cell.text_frame.paragraphs and header_cell.text_frame.paragraphs[0].runs:
                header_font = _font_summary(header_cell.text_frame.paragraphs[0].runs[0].font)
            elif applied_style and applied_style.get('headerTextColor'):
                header_font = {'color': applied_style['headerTextColor'], 'bold': applied_style.get('headerBold')}
            borders_visible = _cell_borders(tc_el_0)
        if n_rows > 1:
            body_cell = table.cell(1, 0)
            tc_el_1 = rows_el[1].findall(_a('tc'))[0] if len(rows_el) > 1 else None
            body_fill = _cell_explicit_fill(tc_el_1, theme_colors) or (applied_style or {}).get('baseFill')
            if body_cell.text_frame.paragraphs and body_cell.text_frame.paragraphs[0].runs:
                body_font = _font_summary(body_cell.text_frame.paragraphs[0].runs[0].font)
        if n_rows > 2:
            tc_el_2 = rows_el[2].findall(_a('tc'))[0] if len(rows_el) > 2 else None
            band_fill_observed = _cell_explicit_fill(tc_el_2, theme_colors)
    except Exception:
        pass

    band_fill = band_fill_observed or (applied_style or {}).get('bandFill')

    col_widths_emu = [table.columns[i].width for i in range(n_cols)]
    row_heights_emu = [table.rows[i].height for i in range(n_rows)]

    style_payload = {
        'rows': n_rows,
        'cols': n_cols,
        'headerFill': header_fill,
        'headerFont': header_font,
        'bodyFill': body_fill,
        'bodyFont': body_font,
        'bandFill': band_fill,
        'bandingEnabled': bool((applied_style or {}).get('bandRow')),
        'bordersVisible': borders_visible,
        'tableStyleId': (applied_style or {}).get('styleId'),
        'colWidthsEmu': col_widths_emu,
        'rowHeightsEmu': row_heights_emu,
        'widthEmu': shape.width,
        'heightEmu': shape.height,
    }

    parts = [f'таблица {n_rows}×{n_cols}']
    if header_fill:
        parts.append(f'шапка {header_fill}')
    if header_font.get('name'):
        size = f" {header_font['size']:.0f}pt" if header_font.get('size') else ''
        parts.append(f"шрифт {header_font['name']}{size}")
    label = ', '.join(parts)

    return {
        'shape_index': shape_index,
        'content_type': 'table',
        'source_kind': 'native',
        'chart_type': None,
        'label': label,
        'style_payload': style_payload,
        'confidence': 1.0,
    }


CHART_TYPE_LABELS = {
    'COLUMN_CLUSTERED': 'столбчатая', 'COLUMN_STACKED': 'столбчатая с накоплением',
    'BAR_CLUSTERED': 'гистограмма', 'BAR_STACKED': 'гистограмма с накоплением',
    'LINE': 'линейная', 'LINE_MARKERS': 'линейная с маркерами',
    'PIE': 'круговая', 'DOUGHNUT': 'кольцевая', 'AREA': 'с областями',
    'XY_SCATTER': 'точечная', 'RADAR': 'лепестковая',
}

# Соответствие сырых XML-тегов графика (barChart/lineChart/...) человекочитаемому
# типу и приблизительному CHART_TYPE-имени в духе python-pptx XL_CHART_TYPE —
# используется фолбэком, когда сам объект python-pptx Chart недоступен.
_XML_CHART_TAG_TYPE = {
    'barChart': lambda bar_dir: 'BAR_CLUSTERED' if bar_dir == 'bar' else 'COLUMN_CLUSTERED',
    'lineChart': lambda _: 'LINE',
    'pieChart': lambda _: 'PIE',
    'doughnutChart': lambda _: 'DOUGHNUT',
    'areaChart': lambda _: 'AREA',
    'scatterChart': lambda _: 'XY_SCATTER',
    'radarChart': lambda _: 'RADAR',
}


def _extract_chart_xml_bytes(shape, pptx_zip, slide_part):
    """Достаёт сырые байты chart-части графика напрямую из архива pptx, в обход
    python-pptx part-type resolution (которая ломается, если графики сохранены
    с нестандартным именем части/content-type, например ppt/extra/otherN.xml —
    встречается в реальных презентациях, экспортированных не из PowerPoint)."""
    try:
        graphic_frame = shape._element
        chart_ref = graphic_frame.find(f'.//{{{C_NS}}}chart')
        if chart_ref is None:
            # Иногда ссылка лежит через a:graphic/a:graphicData/c:chart с r:id
            chart_ref = graphic_frame.find(f'.//{{http://schemas.openxmlformats.org/drawingml/2006/main}}graphicData/{{{C_NS}}}chart')
        if chart_ref is None:
            return None
        r_id = chart_ref.get(f'{{{R_NS}}}id')
        if not r_id:
            return None
        rels = slide_part.rels
        if r_id not in rels:
            return None
        target_partname = rels[r_id].target_partname
        part_path = str(target_partname).lstrip('/')
        return pptx_zip.read(part_path)
    except Exception:
        return None


def _parse_chart_xml(xml_bytes, theme_colors):
    """Парсит сырой c:chartSpace XML напрямую (lxml/ElementTree), извлекая тип
    графика, цвета серий (через explicit solidFill/gradFill spPr или schemeClr),
    легенду/заголовок. Работает независимо от того, смог ли python-pptx
    распознать эту chart-часть как Part."""
    try:
        root = ET.fromstring(xml_bytes)
    except Exception:
        return None

    chart_el = root.find(_c('chart'))
    if chart_el is None:
        return None
    plot_area = chart_el.find(_c('plotArea'))
    if plot_area is None:
        return None

    chart_type_name = None
    bar_dir = None
    series_colors = []
    n_series = 0
    n_categories = 0

    for tag, resolver in _XML_CHART_TAG_TYPE.items():
        chart_tag_el = plot_area.find(_c(tag))
        if chart_tag_el is None:
            continue
        bar_dir_el = chart_tag_el.find(_c('barDir'))
        bar_dir = bar_dir_el.get('val') if bar_dir_el is not None else None
        chart_type_name = resolver(bar_dir)

        for ser_el in chart_tag_el.findall(_c('ser')):
            n_series += 1
            color = None
            sp_pr = ser_el.find(_c('spPr'))
            if sp_pr is not None:
                solid = sp_pr.find(_a('solidFill'))
                if solid is not None:
                    color = _resolve_scheme_color(solid, theme_colors)
                if not color:
                    grad = sp_pr.find(_a('gradFill'))
                    if grad is not None:
                        gs_list = grad.find(_a('gsLst'))
                        if gs_list is not None:
                            first_gs = gs_list.find(_a('gs'))
                            if first_gs is not None:
                                color = _resolve_scheme_color(first_gs, theme_colors)
            if color:
                series_colors.append(color)
            if n_categories == 0:
                cat_el = ser_el.find(_c('cat'))
                if cat_el is not None:
                    pt_count_el = cat_el.find(f'.//{_c("ptCount")}')
                    if pt_count_el is not None:
                        try:
                            n_categories = int(pt_count_el.get('val'))
                        except (TypeError, ValueError):
                            pass
        break  # берём первый найденный тип графика (комбинированные графики — редкость)

    if chart_type_name is None:
        return None

    has_legend = chart_el.find(f'.//{_c("legend")}') is not None
    has_title = False
    title_el = chart_el.find(_c('title'))
    auto_title_deleted = chart_el.find(_c('autoTitleDeleted'))
    if title_el is not None and (auto_title_deleted is None or auto_title_deleted.get('val') != '1'):
        has_title = True

    gap_width = None
    gap_el = plot_area.find(f'.//{_c("gapWidth")}')
    if gap_el is not None:
        try:
            gap_width = int(gap_el.get('val'))
        except (TypeError, ValueError):
            pass

    return {
        'chartType': chart_type_name,
        'barDir': bar_dir,
        'seriesColors': series_colors,
        'seriesCount': n_series,
        'categoryCount': n_categories,
        'hasLegend': has_legend,
        'hasTitle': has_title,
        'gapWidth': gap_width,
    }


def _analyze_native_chart(shape, shape_index, pptx_zip, slide_part, theme_colors):
    chart_obj_ok = False
    chart_type_name = None
    series_colors = []
    has_legend = False
    has_title = False
    xml_details = {}

    try:
        chart = shape.chart
        chart_obj_ok = True
    except Exception:
        chart = None

    if chart_obj_ok:
        try:
            chart_type_name = chart.chart_type.name if chart.chart_type else None
        except Exception:
            chart_type_name = None
        try:
            for plot in chart.plots:
                for series in plot.series:
                    color = None
                    try:
                        if series.format.fill.type is not None:
                            color = _safe_rgb(series.format.fill.fore_color)
                    except Exception:
                        color = None
                    if color:
                        series_colors.append(color)
        except Exception:
            pass
        try:
            has_legend = bool(chart.has_legend)
        except Exception:
            pass
        try:
            has_title = bool(getattr(chart, 'has_title', False))
        except Exception:
            pass

    # python-pptx не смог дать объект Chart (нестандартный путь chart-части и т.п.),
    # либо не смог разобрать оттуда серии/цвета — пробуем прочитать XML части
    # напрямую из архива, в обход part-type resolution.
    if not chart_obj_ok or (not series_colors and chart_type_name is None):
        xml_bytes = _extract_chart_xml_bytes(shape, pptx_zip, slide_part)
        if xml_bytes:
            parsed = _parse_chart_xml(xml_bytes, theme_colors)
            if parsed:
                xml_details = parsed
                chart_type_name = chart_type_name or parsed.get('chartType')
                if not series_colors:
                    series_colors = parsed.get('seriesColors', [])
                has_legend = has_legend or parsed.get('hasLegend', False)
                has_title = has_title or parsed.get('hasTitle', False)

    if chart_type_name is None and not xml_details:
        # Ни объектная модель, ни прямой разбор XML ничего не дали — тег всё равно
        # оставляем (сам факт наличия графика уже полезен), но без деталей стиля.
        return {
            'shape_index': shape_index,
            'content_type': 'chart',
            'source_kind': 'native',
            'chart_type': None,
            'label': 'диаграмма (детали стиля недоступны для чтения)',
            'style_payload': {'widthEmu': shape.width, 'heightEmu': shape.height},
            'confidence': 0.5,
        }

    style_payload = {
        'chartType': chart_type_name,
        'barDir': xml_details.get('barDir'),
        'seriesColors': series_colors,
        'seriesCount': xml_details.get('seriesCount'),
        'categoryCount': xml_details.get('categoryCount'),
        'hasLegend': has_legend,
        'hasTitle': has_title,
        'gapWidth': xml_details.get('gapWidth'),
        'widthEmu': shape.width,
        'heightEmu': shape.height,
        'extractedVia': 'chart_object' if chart_obj_ok and (series_colors or chart_type_name) and not xml_details else (
            'xml_fallback' if xml_details else 'chart_object'
        ),
    }

    human_type = CHART_TYPE_LABELS.get(chart_type_name, chart_type_name or 'график')
    parts = [f'{human_type} диаграмма']
    if series_colors:
        parts.append('цвета: ' + ', '.join(series_colors[:4]))

    # confidence=1.0 при полноценном чтении через объект python-pptx, 0.85 если
    # понадобился XML-фолбэк (данные надёжны, но путь чтения нестандартный).
    confidence = 1.0 if (chart_obj_ok and not xml_details) else 0.85

    return {
        'shape_index': shape_index,
        'content_type': 'chart',
        'source_kind': 'native',
        'chart_type': chart_type_name,
        'label': ', '.join(parts),
        'style_payload': style_payload,
        'confidence': confidence,
    }


def _cluster_positions(values, tolerance):
    """Кластеризует числа с допуском tolerance, возвращает список (представитель, [индексы])."""
    order = sorted(range(len(values)), key=lambda i: values[i])
    clusters = []
    for i in order:
        v = values[i]
        placed = False
        for c in clusters:
            if abs(c['ref'] - v) <= tolerance:
                c['items'].append(i)
                placed = True
                break
        if not placed:
            clusters.append({'ref': v, 'items': [i]})
    return clusters


def _detect_table_imitation(slide, shape_index_map, theme_colors):
    """Ищет группы текстовых блоков (TEXT_BOX/PLACEHOLDER с текстом), выстроенных в
    регулярную сетку по left/top — минимум 2 строки и 2 столбца, чтобы не путать
    с обычным двухколоночным текстом."""
    candidates = []
    for shape in slide.shapes:
        try:
            if not shape.has_text_frame or not shape.text_frame.text.strip():
                continue
            if shape.shape_type is not None and shape.shape_type == 19:  # TABLE — уже обработана отдельно
                continue
            if getattr(shape, 'has_table', False):
                continue
            candidates.append(shape)
        except Exception:
            continue

    # Реальная сетка таблицы предполагает много одинаковых по размеру ячеек — если размеры
    # блоков сильно различаются (обычные подписи/заголовки разного назначения на слайде),
    # это не таблица, а произвольная раскладка текста. Отбираем самую большую by-size группу
    # "похожих" блоков (ширина и высота отличаются не более чем на 20%) и работаем только с ней.
    if len(candidates) < 6:
        return None

    def _similar_size(a, b):
        if not a.width or not a.height or not b.width or not b.height:
            return False
        return (
            abs(a.width - b.width) <= 0.2 * max(a.width, b.width)
            and abs(a.height - b.height) <= 0.2 * max(a.height, b.height)
        )

    best_group = []
    for seed in candidates:
        group = [s for s in candidates if _similar_size(seed, s)]
        if len(group) > len(best_group):
            best_group = group
    candidates = best_group

    if len(candidates) < 6:
        return None

    lefts = [s.left for s in candidates if s.left is not None]
    tops = [s.top for s in candidates if s.top is not None]
    if len(lefts) < 6 or len(tops) < 6:
        return None

    avg_width = sum(s.width for s in candidates if s.width) / len(candidates)
    avg_height = sum(s.height for s in candidates if s.height) / len(candidates)
    col_tolerance = max(int(avg_width * 0.12), EMU_PER_PT * 4)
    row_tolerance = max(int(avg_height * 0.2), EMU_PER_PT * 4)

    col_clusters = _cluster_positions(lefts, col_tolerance)
    row_clusters = _cluster_positions(tops, row_tolerance)

    n_cols = len(col_clusters)
    n_rows = len(row_clusters)

    if n_cols < 2 or n_rows < 2:
        return None
    # Сетка должна почти точно объяснять число отобранных (уже однородных по размеру) блоков —
    # иначе это совпадение, а не настоящая табличная раскладка.
    if n_cols * n_rows < len(candidates) or n_cols * n_rows > len(candidates) * 1.34:
        return None

    fills = []
    fonts = []
    alignments = []
    for shape in candidates:
        try:
            fill = _fill_color(shape.fill)
            if not fill:
                # У имитаций часто заливка задана через schemeClr в самом shape XML,
                # а не через понятную python-pptx модель — пробуем достать напрямую.
                sp_pr = shape._element.find(f'.//{_a("spPr")}')
                if sp_pr is not None:
                    fill = _fill_rgb_from_element(sp_pr, theme_colors)
            if fill:
                fills.append(fill)
            if shape.text_frame.paragraphs:
                para = shape.text_frame.paragraphs[0]
                if para.runs:
                    fonts.append(_font_summary(para.runs[0].font))
                if para.alignment is not None:
                    alignments.append(str(para.alignment))
        except Exception:
            continue

    # Доминирующая заливка (наиболее частая, если варьируется по строкам — banding).
    fill_counts = defaultdict(int)
    for f in fills:
        fill_counts[f] += 1
    dominant_fill = max(fill_counts, key=fill_counts.get) if fill_counts else None
    distinct_fills = sorted(set(fills))

    style_payload = {
        'rows': n_rows,
        'cols': n_cols,
        'cellFills': fills[:12],
        'distinctFills': distinct_fills,
        'dominantFill': dominant_fill,
        'sampleFont': fonts[0] if fonts else {},
        'alignment': alignments[0] if alignments else None,
        'blockCount': len(candidates),
        'avgBlockWidthEmu': int(avg_width),
        'avgBlockHeightEmu': int(avg_height),
    }

    label = f'имитация таблицы {n_rows}×{n_cols} текстовыми блоками'
    return {
        'shape_index': shape_index_map.get(id(candidates[0]), 0),
        'content_type': 'table',
        'source_kind': 'imitation',
        'chart_type': None,
        'label': label,
        'style_payload': style_payload,
        'confidence': 0.7,
    }


def _dominant_colors(img_bgr, k=4):
    """k доминирующих цветов изображения через простое квантование гистограммы (без sklearn)."""
    small = cv2.resize(img_bgr, (60, 60), interpolation=cv2.INTER_AREA)
    pixels = small.reshape(-1, 3).astype(np.float32)
    criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 15, 1.0)
    try:
        _, labels, centers = cv2.kmeans(pixels, k, None, criteria, 3, cv2.KMEANS_RANDOM_CENTERS)
    except Exception:
        return []
    counts = np.bincount(labels.flatten())
    order = np.argsort(-counts)
    colors = []
    for i in order:
        b, g, r = centers[i]
        colors.append('#{:02X}{:02X}{:02X}'.format(int(r), int(g), int(b)))
    return colors


def _background_color_and_mask(img):
    """Оценивает цвет фона по рамке изображения (обычно однородный у графиков/картинок
    с чартами) и возвращает бинарную маску 'не фон' (255 = контент, 0 = фон)."""
    h, w = img.shape[:2]
    border = np.concatenate([
        img[0:max(2, h // 50), :].reshape(-1, 3),
        img[-max(2, h // 50):, :].reshape(-1, 3),
        img[:, 0:max(2, w // 50)].reshape(-1, 3),
        img[:, -max(2, w // 50):].reshape(-1, 3),
    ])
    bg_color = np.median(border, axis=0)
    diff = np.linalg.norm(img.astype(np.int16) - bg_color.astype(np.int16), axis=2)
    mask = (diff > 30).astype(np.uint8) * 255
    return bg_color, mask


def _classify_chart_image(image_bytes):
    """Эвристическая детекция 'похоже на график' + примерный тип и палитра, через OpenCV.
    Возвращает None, если признаков графика не найдено.

    Подход: находим однородный цвет фона по рамке изображения, строим маску 'контент
    против фона', разделяем связные компоненты (после эрозии, чтобы разорвать тонкие
    линии осей) и смотрим на их форму (прямоугольник/сектор круга) и суммарное покрытие.
    Настоящий график на графике/диаграмме обычно имеет умеренное покрытие (10-70%) и
    несколько крупных однотонных геометрических областей; фотография или случайный
    шум — почти полное покрытие без чистой геометрии, обычный текстовый слайд —
    маленькое покрытие без крупных фигур."""
    if not _CV2_AVAILABLE:
        return None
    try:
        arr = np.frombuffer(image_bytes, dtype=np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if img is None:
            return None
        h, w = img.shape[:2]
        if h < 40 or w < 40:
            return None

        bg_color, mask = _background_color_and_mask(img)
        coverage = float(mask.sum()) / 255 / (h * w)

        # Слишком пусто (обычный текст/иконка) или почти сплошная заливка без структуры
        # (фото, скан, шум) — не похоже на график.
        if coverage < 0.03 or coverage > 0.85:
            return None

        kernel = np.ones((5, 5), np.uint8)
        eroded = cv2.erode(mask, kernel, iterations=1)
        n_labels, labels, stats, _ = cv2.connectedComponentsWithStats(eroded, connectivity=8)

        rect_like = 0
        circle_like = 0
        large_blobs = 0
        aligned_bases = defaultdict(int)  # bottom-y (с допуском) -> число блоков, общая база = столбцы над осью
        blob_colors = []  # средний цвет каждого крупного геометрического блока (для палитры серий)

        for i in range(1, n_labels):
            x, y, bw, bh, area = stats[i]
            if area < (h * w) * 0.008:
                continue
            large_blobs += 1
            fill_ratio = area / (bw * bh) if bw * bh else 0
            aspect_tall = bh > bw * 1.2
            comp_mask_bool = labels == i
            mean_color = img[comp_mask_bool].mean(axis=0) if comp_mask_bool.any() else None
            if mean_color is not None:
                b, g, r = mean_color
                blob_colors.append('#{:02X}{:02X}{:02X}'.format(int(r), int(g), int(b)))
            if fill_ratio > 0.85 and (aspect_tall or abs(bw - bh) < 0.3 * max(bw, bh)):
                rect_like += 1
                base_bucket = round((y + bh) / max(h * 0.03, 4))
                aligned_bases[base_bucket] += 1
            elif fill_ratio > 0.6:
                # проверяем похожесть на сектор/круг отдельным контуром компоненты
                comp_mask = (labels == i).astype(np.uint8) * 255
                contours, _ = cv2.findContours(comp_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                if contours:
                    cnt = max(contours, key=cv2.contourArea)
                    (cx, cy), radius = cv2.minEnclosingCircle(cnt)
                    circle_area = math.pi * radius * radius
                    if circle_area > 0 and area / circle_area > 0.55:
                        circle_like += 1

        if large_blobs == 0:
            return None

        bars_on_shared_base = max(aligned_bases.values()) if aligned_bases else 0

        score = 0
        if bars_on_shared_base >= 3:
            score += 3  # несколько прямоугольников с общей базой — гистограмма/столбчатая
        elif rect_like >= 3:
            score += 2
        if circle_like >= 1 and rect_like == 0:
            score += 2  # круговая/кольцевая
        if 0.1 <= coverage <= 0.6 and large_blobs >= 2:
            score += 1

        if score < 2:
            return None

        if circle_like >= 1 and rect_like == 0:
            chart_type_guess = 'PIE'
        elif bars_on_shared_base >= 3 or rect_like >= 3:
            chart_type_guess = 'COLUMN_CLUSTERED'
        else:
            chart_type_guess = 'UNKNOWN'

        confidence = min(0.35 + score * 0.1, 0.75)
        colors = _dominant_colors(img)

        # Палитра серий: доминирующие цвета крупных геометрических блоков (без фона),
        # отдельно от общей доминирующей палитры изображения — полезнее для имитации стиля.
        blob_color_counts = defaultdict(int)
        for c in blob_colors:
            blob_color_counts[c] += 1
        series_palette = sorted(blob_color_counts, key=blob_color_counts.get, reverse=True)[:6]

        bg_hex = '#{:02X}{:02X}{:02X}'.format(int(bg_color[2]), int(bg_color[1]), int(bg_color[0]))

        return {
            'chart_type': chart_type_guess,
            'confidence': confidence,
            'dominantColors': colors,
            'seriesPalette': series_palette,
            'backgroundColor': bg_hex,
            'signals': {
                'coverage': round(coverage, 3),
                'rectLike': rect_like,
                'circleLike': circle_like,
                'barsOnSharedBase': bars_on_shared_base,
                'largeBlobs': large_blobs,
            },
        }
    except Exception:
        return None


def _analyze_picture_shape(shape, shape_index, get_image_bytes):
    try:
        image_bytes = get_image_bytes(shape)
    except Exception:
        return None
    if not image_bytes:
        return None

    result = _classify_chart_image(image_bytes)
    if result is None:
        return None

    human_type = CHART_TYPE_LABELS.get(result['chart_type'], 'график (тип не определён уверенно)')
    label = f'изображение, похоже на {human_type}'
    if result.get('seriesPalette'):
        label += ', цвета: ' + ', '.join(result['seriesPalette'][:3])

    return {
        'shape_index': shape_index,
        'content_type': 'chart',
        'source_kind': 'image',
        'chart_type': result['chart_type'],
        'label': label,
        'style_payload': {
            'dominantColors': result.get('dominantColors', []),
            'seriesPalette': result.get('seriesPalette', []),
            'backgroundColor': result.get('backgroundColor'),
            'signals': result.get('signals', {}),
            'widthEmu': shape.width,
            'heightEmu': shape.height,
        },
        'confidence': result['confidence'],
    }


def detect_slide_content_tags(slide, pptx_path=None):
    """Главная точка входа: принимает pptx Slide (и, опционально, путь к самому
    .pptx файлу — нужен для чтения theme/tableStyles/chart XML напрямую из архива,
    в обход python-pptx part resolution). Возвращает список тегов (см. докстринг
    модуля). Если pptx_path не передан, работает в упрощённом режиме (без
    theme-color resolution и XML-фолбэка для графиков) — используется как
    защитная деградация, а не основной путь."""
    tags = []
    shape_index_map = {}

    theme_colors = {}
    table_styles = {}
    pptx_zip = None
    slide_part = slide.part if hasattr(slide, 'part') else None

    if pptx_path:
        try:
            pptx_zip = zipfile.ZipFile(pptx_path)
            theme_colors = _load_theme_colors(pptx_zip, slide_part) if slide_part else {}
            table_styles = _load_table_styles(pptx_zip, theme_colors) if theme_colors is not None else _load_table_styles(pptx_zip, {})
        except Exception:
            pptx_zip = None

    def walk(shapes, index_offset=0):
        idx = index_offset
        for shape in shapes:
            shape_index_map[id(shape)] = idx
            try:
                if getattr(shape, 'has_table', False):
                    tags.append(_analyze_native_table(shape, idx, table_styles, theme_colors))
                elif getattr(shape, 'has_chart', False):
                    if pptx_zip is not None and slide_part is not None:
                        tags.append(_analyze_native_chart(shape, idx, pptx_zip, slide_part, theme_colors))
                    else:
                        # Без доступа к архиву — прежнее упрощённое поведение (без XML-фолбэка).
                        tags.append(_analyze_native_chart_simple(shape, idx))
                elif shape.shape_type == 13:  # PICTURE
                    def get_bytes(s=shape):
                        return s.image.blob
                    tag = _analyze_picture_shape(shape, idx, get_bytes)
                    if tag:
                        tags.append(tag)
                elif shape.shape_type == 6:  # GROUP
                    walk(shape.shapes, idx)
            except Exception:
                pass
            idx += 1

    walk(slide.shapes)

    imitation = _detect_table_imitation(slide, shape_index_map, theme_colors)
    if imitation:
        tags.append(imitation)

    if pptx_zip is not None:
        pptx_zip.close()

    return tags


def _analyze_native_chart_simple(shape, shape_index):
    """Упрощённый анализ графика без доступа к архиву pptx (без theme resolution
    и XML-фолбэка) — только через объектную модель python-pptx. Используется, если
    detect_slide_content_tags вызван без pptx_path (защитная деградация)."""
    try:
        chart = shape.chart
    except Exception:
        return {
            'shape_index': shape_index,
            'content_type': 'chart',
            'source_kind': 'native',
            'chart_type': None,
            'label': 'диаграмма (детали стиля недоступны для чтения)',
            'style_payload': {'widthEmu': shape.width, 'heightEmu': shape.height},
            'confidence': 0.5,
        }
    try:
        chart_type_name = chart.chart_type.name if chart.chart_type else None
    except Exception:
        chart_type_name = None

    series_colors = []
    try:
        for plot in chart.plots:
            for series in plot.series:
                color = None
                try:
                    if series.format.fill.type is not None:
                        color = _safe_rgb(series.format.fill.fore_color)
                except Exception:
                    color = None
                if color:
                    series_colors.append(color)
    except Exception:
        pass

    has_legend = False
    try:
        has_legend = bool(chart.has_legend)
    except Exception:
        pass

    style_payload = {
        'chartType': chart_type_name,
        'seriesColors': series_colors,
        'hasLegend': has_legend,
        'hasTitle': bool(getattr(chart, 'has_title', False)),
        'widthEmu': shape.width,
        'heightEmu': shape.height,
    }

    human_type = CHART_TYPE_LABELS.get(chart_type_name, chart_type_name or 'график')
    parts = [f'{human_type} диаграмма']
    if series_colors:
        parts.append('цвета: ' + ', '.join(series_colors[:4]))

    return {
        'shape_index': shape_index,
        'content_type': 'chart',
        'source_kind': 'native',
        'chart_type': chart_type_name,
        'label': ', '.join(parts),
        'style_payload': style_payload,
        'confidence': 1.0,
    }

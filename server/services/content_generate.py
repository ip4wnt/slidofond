#!/usr/bin/env python3
"""
Block 3 — генерация таблиц и графиков по промпту в стиле презентации-донора.

Вход (JSON-конфиг, путь к нему передаётся единственным аргументом командной строки):
{
  "mode": "table" | "chart",
  "donorPath": "/abs/path/to/donor.pptx",   # презентация-донор (макет + стиль)
  "donorSlideIndex": 0,                      # индекс слайда-донора внутри donorPath
  "donorShapeIndex": 5,                      # индекс фигуры-донора (таблица/график) на этом слайде
  "stylePayload": {...},                     # style_payload тега (см. content_tags.py), может быть {}
  "output": "/abs/path/to/result.pptx",
  "table": {                                 # только для mode == "table"
     "headers": ["Регион", "2024", "2025"],
     "rows": [["Москва", "100", "120"], ...]
  },
  "chart": {                                 # только для mode == "chart"
     "chartType": "BAR_CLUSTERED",           # опционально — иначе берём из stylePayload донора
     "categories": ["Q1", "Q2", "Q3", "Q4"],
     "series": [{"name": "Выручка", "values": [10, 20, 15, 30]}, ...]
  }
}

Выход в stdout — JSON: либо {"output": "...", "rows": N, "cols": N, ...} при успехе,
либо {"error": "...", "errorCode": "..."} при управляемой ошибке (например данные не
помещаются на слайд донора). errorCode == 'TOO_LARGE' — сигнал вызывающему коду (Node)
показать пользователю предложение сократить данные (см. capacity-расчёт ниже).

Общий подход: НЕ пытаемся копировать layout/master между презентациями (это описано как
сложная/хрупкая операция в pptx_build.py). Вместо этого открываем сам файл-донор через
python-pptx, дублируем в нём слайд-донор (дублирование В ПРЕДЕЛАХ одного файла — простая
операция, слайд автоматически наследует свой оригинальный layout/master/тему), на копии
слайда заменяем фигуру-донор (таблицу/график) на новую с теми же геометрией и стилем, но
с данными пользователя, и сохраняем результат как отдельный .pptx с этим одним слайдом
(остальные слайды донора не нужны получателю — на выходе должен быть "готовый .pptx слайд").
"""
import copy
import json
import sys
import traceback

from pptx import Presentation
from pptx.util import Emu, Pt
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE
from pptx.oxml.ns import qn


# ---------------------------------------------------------------------------
# Общие утилиты
# ---------------------------------------------------------------------------

def _hex_to_rgb(hex_str):
    """'#RRGGBB' -> RGBColor. Возвращает None для некорректного/отсутствующего значения."""
    if not hex_str or not isinstance(hex_str, str):
        return None
    s = hex_str.lstrip('#')
    if len(s) != 6:
        return None
    try:
        return RGBColor.from_string(s.upper())
    except Exception:
        return None


# Минимально комфортный размер шрифта для читаемого текста на слайде (пункты).
MIN_FONT_PT = 10
# Минимальная высота строки таблицы (пункты) при таком шрифте — с небольшими отступами ячейки.
MIN_ROW_HEIGHT_PT = 18
# Минимальная ширина колонки (пункты), ниже которой текст будет неизбежно съезжать.
MIN_COL_WIDTH_PT = 45


def compute_table_capacity(width_emu, height_emu, style_payload):
    """Считает максимум строк/столбцов, которые ещё помещаются в габарит width_emu x height_emu
    при минимально комфортном размере шрифта. Использует размер шрифта тела таблицы из
    style_payload донора как отправную точку (если он МЕНЬШЕ MIN_FONT_PT — всё равно берём
    MIN_FONT_PT, чтобы не рекомендовать нечитаемый результат)."""
    body_font = (style_payload or {}).get('bodyFont') or {}
    font_pt = body_font.get('size') or 12
    font_pt = max(MIN_FONT_PT, min(font_pt, 24))

    row_height_pt = max(MIN_ROW_HEIGHT_PT, font_pt * 1.6)
    col_width_pt = MIN_COL_WIDTH_PT

    width_pt = width_emu / 12700
    height_pt = height_emu / 12700

    max_cols = max(1, int(width_pt // col_width_pt))
    max_rows = max(1, int(height_pt // row_height_pt))
    return {'maxRows': max_rows, 'maxCols': max_cols, 'fontPt': font_pt}


def compute_chart_capacity(width_emu, height_emu):
    """Для графиков ограничение мягче — категории сжимаются лучше строк таблицы,
    но чрезмерное число категорий/рядов всё равно превращает график в нечитаемую кашу."""
    width_pt = width_emu / 12700
    height_pt = height_emu / 12700
    # Эмпирически: комфортно смотрится ~1 категория на 24pt ширины, не более 8 рядов легенды.
    max_categories = max(3, int(width_pt // 24))
    max_series = 6
    return {'maxCategories': max_categories, 'maxSeries': max_series}


# ---------------------------------------------------------------------------
# Дублирование слайда внутри одного файла (даёт нам layout/master/тему бесплатно)
# ---------------------------------------------------------------------------

def duplicate_slide_in_place(prs, slide_index):
    """Дублирует слайд с индексом slide_index, добавляя копию в конец презентации,
    и возвращает новый объект Slide. Копия ссылается на тот же slide_layout, поэтому
    полностью наследует оформление (фон, тема, плейсхолдеры) без ручной пересборки OOXML."""
    source = prs.slides[slide_index]
    blank_layout = source.slide_layout
    dest = prs.slides.add_slide(blank_layout)

    # add_slide уже кладёт стандартные плейсхолдеры layout'а — удаляем их, чтобы не дублировать
    # с оригинальными скопированными ниже.
    for shape in list(dest.shapes):
        shape._element.getparent().remove(shape._element)

    # Глубоко копируем каждый shape исходного слайда в целевой (включая связи r:embed для картинок).
    for shape in source.shapes:
        new_el = copy.deepcopy(shape._element)
        dest.shapes._spTree.append(new_el)

    _copy_shape_relationships(source, dest)
    return dest


def _copy_shape_relationships(source_slide, dest_slide):
    """Копирует relationship-записи (картинки, embed-объекты), на которые ссылаются
    r:embed/r:id атрибуты внутри скопированных shape-элементов, в part исходного слайда,
    чтобы новый слайд не ссылался на несуществующие в его собственном .rels связи."""
    src_part = source_slide.part
    dest_part = dest_slide.part
    r_ns = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
    seen = set()
    for el in dest_part._element.iter():
        for attr, value in list(el.attrib.items()):
            if not attr.startswith(f'{{{r_ns}}}'):
                continue
            rid = value
            if not rid or rid in seen:
                continue
            seen.add(rid)
            try:
                rel = src_part.rels[rid]
            except KeyError:
                continue
            if rel.is_external:
                dest_part.rels.get_or_add_ext_rel(rel.reltype, rel.target_ref)
            else:
                dest_part.relate_to(rel.target_part, rel.reltype)


def find_shape_by_index(slide, shape_index):
    shapes = list(slide.shapes)
    if shape_index < 0 or shape_index >= len(shapes):
        return None
    return shapes[shape_index]


def remove_shape(shape):
    shape._element.getparent().remove(shape._element)


def clear_donor_content(slide, keep_shape=None):
    """Убирает со слайда весь контент, привязанный к оригинальным данным донора —
    таблицы, графики и обычные (не-placeholder) текстовые подписи — оставляя только
    структурные элементы макета: заголовок, номер слайда, декоративные auto-shape
    подложки самого layout'а (они относятся к визуальному языку шаблона, а не к
    конкретным данным донора). `keep_shape`, если передан, не удаляется даже если
    подпадает под условие."""
    from pptx.enum.shapes import MSO_SHAPE_TYPE

    to_remove = []
    for shape in slide.shapes:
        if keep_shape is not None and shape._element is keep_shape._element:
            continue
        if shape.is_placeholder:
            continue
        if shape.shape_type in (MSO_SHAPE_TYPE.TABLE, MSO_SHAPE_TYPE.CHART, MSO_SHAPE_TYPE.TEXT_BOX):
            to_remove.append(shape)
    for shape in to_remove:
        remove_shape(shape)


# ---------------------------------------------------------------------------
# Генерация таблицы
# ---------------------------------------------------------------------------

def build_table_shape(slide, left, top, width, height, headers, rows, style_payload):
    """Создаёт новую таблицу нужного размера на месте старой, применяя стиль из style_payload:
    заливка шапки/тела/чередующихся строк, шрифты, границы. rows включает уже усечённые (если
    требовалось) данные — усечение делает вызывающий код на основе compute_table_capacity."""
    n_rows = len(rows) + 1  # + строка заголовков
    n_cols = len(headers)

    graphic_frame = slide.shapes.add_table(n_rows, n_cols, left, top, width, height)
    table = graphic_frame.table

    # Пытаемся выключить встроенный "первая строка полужирным по умолчанию" стиль PowerPoint —
    # он бы конфликтовал с нашими явными заливками/шрифтами.
    tbl_pr = table._tbl.find(qn('a:tblPr'))
    if tbl_pr is not None:
        tbl_pr.set('firstRow', '1')
        tbl_pr.set('bandRow', '1' if style_payload.get('bandingEnabled') else '0')

    header_fill = _hex_to_rgb(style_payload.get('headerFill'))
    body_fill = _hex_to_rgb(style_payload.get('bodyFill'))
    band_fill = _hex_to_rgb(style_payload.get('bandFill'))
    header_font = style_payload.get('headerFont') or {}
    body_font = style_payload.get('bodyFont') or {}
    header_font_color = _hex_to_rgb(header_font.get('color')) or RGBColor(0xFF, 0xFF, 0xFF)
    body_font_color = _hex_to_rgb(body_font.get('color')) or RGBColor(0x20, 0x20, 0x20)
    body_font_size = body_font.get('size') or 12
    body_font_size = max(MIN_FONT_PT, min(body_font_size, 24))
    body_font_name = body_font.get('name')
    if body_font_name and body_font_name.startswith('+'):
        # '+mn-lt'/'+mj-lt' — тема-относительные ссылки на minor/major latin font, а не имя шрифта;
        # в новой автономной таблице такой темы может не быть под рукой, поэтому не подставляем их
        # как буквальное имя шрифта (иначе PowerPoint покажет несуществующий шрифт "+mn-lt").
        body_font_name = None

    for c in range(n_cols):
        cell = table.cell(0, c)
        cell.text = str(headers[c])
        if header_fill:
            cell.fill.solid()
            cell.fill.fore_color.rgb = header_fill
        for para in cell.text_frame.paragraphs:
            para.alignment = PP_ALIGN.CENTER
            for run in para.runs:
                run.font.bold = bool(header_font.get('bold', True))
                run.font.color.rgb = header_font_color
                run.font.size = Pt(body_font_size)

    for r, row_values in enumerate(rows, start=1):
        is_band_row = band_fill is not None and style_payload.get('bandingEnabled') and (r % 2 == 0)
        for c in range(n_cols):
            cell = table.cell(r, c)
            value = row_values[c] if c < len(row_values) else ''
            cell.text = '' if value is None else str(value)
            fill = band_fill if is_band_row else body_fill
            if fill:
                cell.fill.solid()
                cell.fill.fore_color.rgb = fill
            for para in cell.text_frame.paragraphs:
                for run in para.runs:
                    run.font.color.rgb = body_font_color
                    run.font.size = Pt(body_font_size)
                    if body_font_name:
                        run.font.name = body_font_name
                    run.font.italic = bool(body_font.get('italic', False))

    return graphic_frame


# ---------------------------------------------------------------------------
# Генерация нативного графика
# ---------------------------------------------------------------------------

CHART_TYPE_MAP = {
    'COLUMN_CLUSTERED': XL_CHART_TYPE.COLUMN_CLUSTERED,
    'COLUMN_STACKED': XL_CHART_TYPE.COLUMN_STACKED,
    'BAR_CLUSTERED': XL_CHART_TYPE.BAR_CLUSTERED,
    'BAR_STACKED': XL_CHART_TYPE.BAR_STACKED,
    'LINE': XL_CHART_TYPE.LINE,
    'LINE_MARKERS': XL_CHART_TYPE.LINE_MARKERS,
    'PIE': XL_CHART_TYPE.PIE,
    'DOUGHNUT': XL_CHART_TYPE.DOUGHNUT,
    'AREA': XL_CHART_TYPE.AREA,
    'XY_SCATTER': XL_CHART_TYPE.XY_SCATTER,
    'RADAR': XL_CHART_TYPE.RADAR,
}


def build_chart_shape(slide, left, top, width, height, categories, series_list, style_payload):
    """Создаёт нативный (редактируемый в PowerPoint) график нужного размера на месте старого,
    применяя тип и цвета рядов из style_payload."""
    chart_type_name = (style_payload.get('chartType') or 'COLUMN_CLUSTERED').upper()
    xl_chart_type = CHART_TYPE_MAP.get(chart_type_name, XL_CHART_TYPE.COLUMN_CLUSTERED)

    chart_data = CategoryChartData()
    chart_data.categories = categories
    for series in series_list:
        chart_data.add_series(series['name'], series['values'])

    graphic_frame = slide.shapes.add_chart(xl_chart_type, left, top, width, height, chart_data)
    chart = graphic_frame.chart

    chart.has_legend = bool(style_payload.get('hasLegend', len(series_list) > 1))
    if not style_payload.get('hasTitle', False):
        chart.has_title = False

    series_colors = style_payload.get('seriesColors') or []
    plot = chart.plots[0]
    try:
        gap_width = style_payload.get('gapWidth')
        if gap_width is not None and hasattr(plot, 'gap_width'):
            plot.gap_width = int(gap_width)
    except Exception:
        pass

    for i, plot_series in enumerate(plot.series):
        color_hex = series_colors[i] if i < len(series_colors) else (series_colors[0] if series_colors else None)
        rgb = _hex_to_rgb(color_hex)
        if rgb is None:
            continue
        try:
            if chart_type_name in ('PIE', 'DOUGHNUT'):
                for point in plot_series.points:
                    point.format.fill.solid()
                    point.format.fill.fore_color.rgb = rgb
            else:
                plot_series.format.fill.solid()
                plot_series.format.fill.fore_color.rgb = rgb
        except Exception:
            pass

    return graphic_frame


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main():
    if len(sys.argv) != 2:
        print(json.dumps({'error': 'Ожидается один аргумент — путь к JSON-конфигу'}))
        sys.exit(1)

    with open(sys.argv[1], 'r', encoding='utf-8') as f:
        config = json.load(f)

    mode = config.get('mode')
    donor_path = config['donorPath']
    donor_slide_index = int(config['donorSlideIndex'])
    donor_shape_index = int(config['donorShapeIndex'])
    style_payload = config.get('stylePayload') or {}
    output_path = config['output']

    try:
        prs = Presentation(donor_path)
    except Exception as exc:
        print(json.dumps({'error': f'Не удалось открыть презентацию-донор: {exc}', 'errorCode': 'DONOR_OPEN_FAILED'}))
        sys.exit(0)

    if donor_slide_index < 0 or donor_slide_index >= len(prs.slides):
        print(json.dumps({'error': 'Индекс слайда-донора вне диапазона', 'errorCode': 'DONOR_SLIDE_NOT_FOUND'}))
        sys.exit(0)

    donor_slide = prs.slides[donor_slide_index]
    donor_shape = find_shape_by_index(donor_slide, donor_shape_index)
    if donor_shape is None:
        print(json.dumps({'error': 'Фигура-донор не найдена на слайде', 'errorCode': 'DONOR_SHAPE_NOT_FOUND'}))
        sys.exit(0)

    left, top, width, height = donor_shape.left, donor_shape.top, donor_shape.width, donor_shape.height

    try:
        if mode == 'table':
            table_input = config.get('table') or {}
            headers = table_input.get('headers') or []
            rows = table_input.get('rows') or []
            if not headers:
                print(json.dumps({'error': 'Не переданы заголовки таблицы', 'errorCode': 'BAD_INPUT'}))
                sys.exit(0)

            capacity = compute_table_capacity(width, height, style_payload)
            if len(rows) > capacity['maxRows'] or len(headers) > capacity['maxCols']:
                print(json.dumps({
                    'error': (
                        f"Данные не помещаются на слайд в читаемом виде: передано строк "
                        f"{len(rows)} (максимум {capacity['maxRows']}), колонок {len(headers)} "
                        f"(максимум {capacity['maxCols']}) при шрифте {capacity['fontPt']}pt. "
                        f"Сократите таблицу — уберите часть строк/столбцов — и повторите запрос."
                    ),
                    'errorCode': 'TOO_LARGE',
                    'capacity': capacity,
                    'requested': {'rows': len(rows), 'cols': len(headers)},
                }))
                sys.exit(0)

            new_slide = duplicate_slide_in_place(prs, donor_slide_index)
            target_shape = find_shape_by_index(new_slide, donor_shape_index)
            remove_shape(target_shape)
            clear_donor_content(new_slide)
            build_table_shape(new_slide, left, top, width, height, headers, rows, style_payload)

        elif mode == 'chart':
            chart_input = config.get('chart') or {}
            categories = chart_input.get('categories') or []
            series_list = chart_input.get('series') or []
            if not categories or not series_list:
                print(json.dumps({'error': 'Не переданы категории или ряды графика', 'errorCode': 'BAD_INPUT'}))
                sys.exit(0)

            if chart_input.get('chartType'):
                style_payload = {**style_payload, 'chartType': chart_input['chartType']}

            capacity = compute_chart_capacity(width, height)
            if len(categories) > capacity['maxCategories'] or len(series_list) > capacity['maxSeries']:
                print(json.dumps({
                    'error': (
                        f"Данные не помещаются на слайд в читаемом виде: передано категорий "
                        f"{len(categories)} (максимум {capacity['maxCategories']}), рядов "
                        f"{len(series_list)} (максимум {capacity['maxSeries']}). Сократите "
                        f"число категорий/рядов и повторите запрос."
                    ),
                    'errorCode': 'TOO_LARGE',
                    'capacity': capacity,
                    'requested': {'categories': len(categories), 'series': len(series_list)},
                }))
                sys.exit(0)

            new_slide = duplicate_slide_in_place(prs, donor_slide_index)
            target_shape = find_shape_by_index(new_slide, donor_shape_index)
            remove_shape(target_shape)
            clear_donor_content(new_slide)
            build_chart_shape(new_slide, left, top, width, height, categories, series_list, style_payload)

        else:
            print(json.dumps({'error': f'Неизвестный режим генерации: {mode}', 'errorCode': 'BAD_INPUT'}))
            sys.exit(0)

        # Оставляем в результирующем файле только новый (последний) слайд — пользователю нужен
        # "готовый .pptx слайд", а не вся презентация-донор с довеском.
        new_index = len(prs.slides) - 1
        xml_slides = prs.slides._sldIdLst
        slide_ids = list(xml_slides)
        for i, sld_id in enumerate(slide_ids):
            if i != new_index:
                xml_slides.remove(sld_id)

        prs.save(output_path)
        print(json.dumps({'output': output_path, 'mode': mode}))

    except Exception as exc:
        print(json.dumps({
            'error': f'Внутренняя ошибка генерации: {exc}',
            'errorCode': 'INTERNAL',
            'trace': traceback.format_exc(),
        }))
        sys.exit(0)


if __name__ == '__main__':
    main()

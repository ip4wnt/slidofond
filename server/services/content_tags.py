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
"""
import io
import math
from collections import defaultdict

try:
    import numpy as np
    import cv2
    _CV2_AVAILABLE = True
except Exception:
    _CV2_AVAILABLE = False

EMU_PER_PT = 12700


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
            'color': _safe_rgb(font.color) if font.color else None,
        }
    except Exception:
        return {}


def _analyze_native_table(shape, shape_index):
    table = shape.table
    n_rows = len(table.rows)
    n_cols = len(table.columns)

    header_fill = None
    header_font = {}
    body_fill = None
    body_font = {}
    borders_visible = None

    try:
        if n_rows > 0:
            header_cell = table.cell(0, 0)
            header_fill = _fill_color(header_cell.fill)
            if header_cell.text_frame.paragraphs and header_cell.text_frame.paragraphs[0].runs:
                header_font = _font_summary(header_cell.text_frame.paragraphs[0].runs[0].font)
        if n_rows > 1:
            body_cell = table.cell(1, 0)
            body_fill = _fill_color(body_cell.fill)
            if body_cell.text_frame.paragraphs and body_cell.text_frame.paragraphs[0].runs:
                body_font = _font_summary(body_cell.text_frame.paragraphs[0].runs[0].font)
    except Exception:
        pass

    style_payload = {
        'rows': n_rows,
        'cols': n_cols,
        'headerFill': header_fill,
        'headerFont': header_font,
        'bodyFill': body_fill,
        'bodyFont': body_font,
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


def _analyze_native_chart(shape, shape_index):
    try:
        chart = shape.chart
    except Exception:
        # python-pptx иногда не может разобрать chart part (нестандартный/незарегистрированный
        # content-type), хотя shape.has_chart уже вернул True по одному факту graphicFrame ->
        # chart relationship. Не теряем тег совсем, помечаем как график с неизвестными деталями.
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


def _detect_table_imitation(slide, shape_index_map):
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
    for shape in candidates[:6]:
        try:
            fill = _fill_color(shape.fill)
            if fill:
                fills.append(fill)
            if shape.text_frame.paragraphs and shape.text_frame.paragraphs[0].runs:
                fonts.append(_font_summary(shape.text_frame.paragraphs[0].runs[0].font))
        except Exception:
            continue

    style_payload = {
        'rows': n_rows,
        'cols': n_cols,
        'cellFills': fills,
        'sampleFont': fonts[0] if fonts else {},
        'blockCount': len(candidates),
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
    """Эвристическая детекция 'похоже на график' + примерный тип, через OpenCV.
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

        for i in range(1, n_labels):
            x, y, bw, bh, area = stats[i]
            if area < (h * w) * 0.008:
                continue
            large_blobs += 1
            fill_ratio = area / (bw * bh) if bw * bh else 0
            aspect_tall = bh > bw * 1.2
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

        return {
            'chart_type': chart_type_guess,
            'confidence': confidence,
            'dominantColors': colors,
            'signals': {
                'coverage': round(coverage, 3),
                'rectLike': rect_like,
                'circleLike': circle_like,
                'barsOnSharedBase': bars_on_shared_base,
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
    if result.get('dominantColors'):
        label += ', цвета: ' + ', '.join(result['dominantColors'][:3])

    return {
        'shape_index': shape_index,
        'content_type': 'chart',
        'source_kind': 'image',
        'chart_type': result['chart_type'],
        'label': label,
        'style_payload': {
            'dominantColors': result.get('dominantColors', []),
            'signals': result.get('signals', {}),
            'widthEmu': shape.width,
            'heightEmu': shape.height,
        },
        'confidence': result['confidence'],
    }


def detect_slide_content_tags(slide):
    """Главная точка входа: принимает pptx Slide, возвращает список тегов (см. докстринг модуля)."""
    tags = []
    shape_index_map = {}

    def walk(shapes, index_offset=0):
        idx = index_offset
        for shape in shapes:
            shape_index_map[id(shape)] = idx
            try:
                if getattr(shape, 'has_table', False):
                    tags.append(_analyze_native_table(shape, idx))
                elif getattr(shape, 'has_chart', False):
                    tags.append(_analyze_native_chart(shape, idx))
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

    imitation = _detect_table_imitation(slide, shape_index_map)
    if imitation:
        tags.append(imitation)

    return tags

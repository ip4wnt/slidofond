#!/usr/bin/env python3
"""
Собирает новую презентацию из списка (путь_к_исходному_pptx, индекс_слайда),
копируя слайды "как есть" (со всеми макетами/изображениями/форматированием).

Вход: JSON-файл со списком {"items": [{"path": "...", "index": 0}, ...], "output": "..."}
передаётся как единственный аргумент — путь к этому JSON-файлу.

Использует python-pptx + прямую манипуляцию XML для копирования слайдов между презентациями,
поскольку python-pptx не поддерживает копирование слайдов "из коробки".
"""
import sys
import json
import copy
from pptx import Presentation
from pptx.util import Emu


def clone_slide(dest_prs, src_prs, slide_index):
    src_slide = src_prs.slides[slide_index]
    # Используем layout с тем же именем, либо первый layout назначения как запасной вариант
    layout_name = src_slide.slide_layout.name
    dest_layout = None
    for layout in dest_prs.slide_masters[0].slide_layouts:
        if layout.name == layout_name:
            dest_layout = layout
            break
    if dest_layout is None:
        dest_layout = dest_prs.slide_masters[0].slide_layouts[6] if len(dest_prs.slide_masters[0].slide_layouts) > 6 else dest_prs.slide_masters[0].slide_layouts[0]

    new_slide = dest_prs.slides.add_slide(dest_layout)

    # Удаляем плейсхолдеры, добавленные автоматически layout'ом, чтобы не дублировать содержимое
    for shape in list(new_slide.shapes):
        shape._element.getparent().remove(shape._element)

    # Копируем все шейпы из исходного слайда как XML-элементы
    for shape in src_slide.shapes:
        new_el = copy.deepcopy(shape._element)
        new_slide.shapes._spTree.append(new_el)

    # Копируем связанные изображения/медиа (relationships) исходного слайда в новый слайд
    image_parts_map = {}
    for rel_id, rel in src_slide.part.rels.items():
        if 'image' in rel.reltype:
            try:
                image_part = rel.target_part
                new_rel_id = new_slide.part.relate_to(image_part, rel.reltype)
                image_parts_map[rel_id] = new_rel_id
            except Exception:
                continue

    # Обновляем r:embed / r:id ссылки на изображения в скопированном XML на новые rel id
    if image_parts_map:
        ns = {'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
        for blip in new_slide.shapes._spTree.iter('{http://schemas.openxmlformats.org/drawingml/2006/main}blip'):
            embed_attr = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}embed'
            old_id = blip.get(embed_attr)
            if old_id and old_id in image_parts_map:
                blip.set(embed_attr, image_parts_map[old_id])

    return new_slide


def main():
    config_path = sys.argv[1]
    with open(config_path, 'r', encoding='utf-8') as f:
        config = json.load(f)

    items = config['items']
    output_path = config['output']

    # Берём размеры слайда от первой презентации в списке
    first_src = Presentation(items[0]['path'])
    dest = Presentation()
    dest.slide_width = first_src.slide_width
    dest.slide_height = first_src.slide_height
    # Удаляем стартовый пустой слайд по умолчанию, если он есть
    while len(dest.slides._sldIdLst) > 0:
        rId = dest.slides._sldIdLst[0].rId
        dest.part.drop_rel(rId)
        dest.slides._sldIdLst.remove(dest.slides._sldIdLst[0])

    cache = {}
    for item in items:
        path = item['path']
        idx = item['index']
        if path not in cache:
            cache[path] = Presentation(path)
        src_prs = cache[path]
        clone_slide(dest, src_prs, idx)

    dest.save(output_path)
    print(json.dumps({'ok': True, 'output': output_path, 'slide_count': len(items)}))


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print(json.dumps({'error': str(e)}), file=sys.stderr)
        sys.exit(1)

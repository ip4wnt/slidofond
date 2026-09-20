#!/usr/bin/env python3
"""
Ищет в отдельно приложенном pptx-файле образца (Block 3, вариант "загрузить свой файл-донор
стиля", в отличие от выбора уже размеченного тега из пространства) первую фигуру нужного
content_type ('table' | 'chart') и возвращает её расположение + извлечённый style_payload —
переиспользует ту же детекцию, что применяется при обычной загрузке презентации в систему
(content_tags.py), но не пишет ничего в БД: файл-донор используется одноразово только для
чтения стиля/макета, сам по себе он не становится частью хранилища.

Вход: JSON-конфиг {"path": "/abs/path/donor.pptx", "contentType": "table"|"chart"} —
единственный аргумент командной строки, путь к этому конфигу.
Выход в stdout — JSON:
  {"found": true, "slideIndex": 0, "shapeIndex": 5, "stylePayload": {...}}
  или {"found": false} если во всей презентации нет ни одной подходящей фигуры,
  либо {"error": "..."} при сбое чтения файла.
Приоритет выбора при нескольких найденных фигурах: наибольшая confidence, затем первая
по порядку (слайд, потом индекс фигуры) — тот же принцип, что и в styleReference.js.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from pptx import Presentation
from content_tags import detect_slide_content_tags


def main():
    if len(sys.argv) != 2:
        print(json.dumps({'error': 'Ожидается один аргумент — путь к JSON-конфигу'}))
        sys.exit(1)
    with open(sys.argv[1], 'r', encoding='utf-8') as f:
        config = json.load(f)

    path = config['path']
    content_type = config.get('contentType')
    if content_type not in ('table', 'chart'):
        print(json.dumps({'error': f'Некорректный contentType: {content_type}'}))
        return

    try:
        prs = Presentation(path)
    except Exception as exc:
        print(json.dumps({'error': f'Не удалось открыть файл-донор: {exc}'}))
        return

    best = None
    for slide_index, slide in enumerate(prs.slides):
        try:
            tags = detect_slide_content_tags(slide, path)
        except Exception:
            continue
        for tag in tags:
            if tag['content_type'] != content_type:
                continue
            if best is None or tag['confidence'] > best['confidence']:
                best = {
                    'slideIndex': slide_index,
                    'shapeIndex': tag['shape_index'],
                    'stylePayload': tag['style_payload'],
                    'confidence': tag['confidence'],
                }

    if best is None:
        print(json.dumps({'found': False}))
        return

    print(json.dumps({
        'found': True,
        'slideIndex': best['slideIndex'],
        'shapeIndex': best['shapeIndex'],
        'stylePayload': best['stylePayload'],
    }, ensure_ascii=False))


if __name__ == '__main__':
    main()

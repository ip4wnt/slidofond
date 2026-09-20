#!/usr/bin/env python3
"""
Извлекает из презентации (pptx/ppt/odp) текстовое содержимое каждого слайда,
эвристический заголовок и эвристическое описание, а также метаданные core.xml
(дата создания/изменения, если есть). Результат печатается в stdout как JSON.

Использование: python3 pptx_extract.py <путь_к_файлу>
"""
import sys
import json
import re
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from content_tags import detect_slide_content_tags

def extract_core_props(path):
    try:
        from pptx import Presentation
        prs = Presentation(path)
        core = prs.core_properties
        created = core.created.isoformat() if core.created else None
        modified = core.modified.isoformat() if core.modified else None
        return created, modified
    except Exception:
        return None, None


def shape_text(shape, lines):
    if shape.has_text_frame:
        for para in shape.text_frame.paragraphs:
            text = ''.join(run.text for run in para.runs).strip()
            if not text and para.runs == []:
                text = para.text.strip()
            if text:
                lines.append(text)
    if shape.has_table:
        table = shape.table
        for row in table.rows:
            cells = [c.text.strip() for c in row.cells if c.text.strip()]
            if cells:
                lines.append(' | '.join(cells))
    if shape.shape_type == 6:  # GROUP
        for sub in shape.shapes:
            shape_text(sub, lines)


def build_description(title, lines, max_len=320):
    body_lines = [l for l in lines if l != title]
    text = ' '.join(body_lines) if body_lines else ' '.join(lines)
    text = re.sub(r'\s+', ' ', text).strip()
    if title and body_lines:
        desc = f"{title}. {text}"
    else:
        desc = text or title or '(слайд без текстового содержимого)'
    if len(desc) > max_len:
        desc = desc[:max_len].rsplit(' ', 1)[0] + '…'
    return desc


def main():
    path = sys.argv[1]
    from pptx import Presentation
    prs = Presentation(path)
    created, modified = extract_core_props(path)

    slides_out = []
    all_text_snippets = []

    for idx, slide in enumerate(prs.slides):
        lines = []
        title = ''
        # Заголовок — из placeholder типа title, если есть
        try:
            if slide.shapes.title and slide.shapes.title.text.strip():
                title = slide.shapes.title.text.strip()
        except Exception:
            pass

        for shape in slide.shapes:
            try:
                shape_text(shape, lines)
            except Exception:
                continue

        # убрать дубли подряд, сохранить порядок
        seen = set()
        uniq_lines = []
        for l in lines:
            if l not in seen:
                uniq_lines.append(l)
                seen.add(l)

        if not title and uniq_lines:
            title = uniq_lines[0][:100]

        text_content = '\n'.join(uniq_lines)
        description = build_description(title, uniq_lines)

        try:
            content_tags = detect_slide_content_tags(slide)
        except Exception:
            content_tags = []

        slides_out.append({
            'index': idx,
            'title': title,
            'text_content': text_content,
            'description': description,
            'content_tags': content_tags,
        })
        if text_content:
            all_text_snippets.append(text_content)

    slide_count = len(slides_out)
    combined = ' '.join(all_text_snippets)
    combined = re.sub(r'\s+', ' ', combined).strip()
    summary = combined[:500].rsplit(' ', 1)[0] + '…' if len(combined) > 500 else combined
    if not summary:
        summary = f'Презентация из {slide_count} слайдов без извлекаемого текста.'

    result = {
        'slide_count': slide_count,
        'slides': slides_out,
        'summary_text': summary,
        'file_created_at': created,
        'file_modified_at': modified,
    }
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print(json.dumps({'error': str(e)}), file=sys.stderr)
        sys.exit(1)

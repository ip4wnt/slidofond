#!/usr/bin/env python3
"""
Разбирает загруженный Excel-файл (.xlsx/.xls) для превью в UI перед генерацией
таблицы/графика (Block 3). Не принимает решений о том, какие строки/колонки
использовать — это делает пользователь в интерфейсе; здесь только чтение данных.

Вход: JSON-конфиг {"path": "/abs/path/file.xlsx"} передаётся как единственный аргумент.
Выход в stdout — JSON:
  {"sheets": [{"name": "Лист1", "rows": [["A1", "B1"], ["A2", "B2"], ...], "rowCount": N, "colCount": M}]}
Каждый лист ограничен 500 строками и 50 колонками (защита от случайной загрузки
огромного файла — этого более чем достаточно для превью и выбора данных под один слайд).
Все значения приводятся к строке (числа форматируются без незначащих хвостов,
даты — в ISO); пустая ячейка -> "".
"""
import json
import sys
import datetime

import openpyxl

MAX_ROWS = 500
MAX_COLS = 50


def _cell_to_str(value):
    if value is None:
        return ''
    if isinstance(value, bool):
        return 'TRUE' if value else 'FALSE'
    if isinstance(value, (int,)):
        return str(value)
    if isinstance(value, float):
        if value == int(value):
            return str(int(value))
        return str(round(value, 6))
    if isinstance(value, (datetime.datetime, datetime.date)):
        return value.isoformat()
    return str(value)


def parse_excel(path):
    wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
    sheets = []
    for ws in wb.worksheets:
        rows = []
        for r_idx, row in enumerate(ws.iter_rows(max_row=MAX_ROWS, max_col=MAX_COLS)):
            values = [_cell_to_str(cell.value) for cell in row]
            # Пропускаем полностью пустые строки в начале/конце листа, но не в середине —
            # сохраняем реальную структуру таблицы для корректного индексирования выбора.
            rows.append(values)
        # Обрезаем полностью пустые строки/колонки в хвосте (частый артефакт Excel).
        while rows and all(v == '' for v in rows[-1]):
            rows.pop()
        max_col_used = 0
        for row in rows:
            for i in range(len(row) - 1, -1, -1):
                if row[i] != '':
                    max_col_used = max(max_col_used, i + 1)
                    break
        rows = [row[:max_col_used] for row in rows]

        sheets.append({
            'name': ws.title,
            'rows': rows,
            'rowCount': len(rows),
            'colCount': max_col_used,
            'truncated': ws.max_row is not None and ws.max_row > MAX_ROWS,
        })
    return {'sheets': sheets}


def main():
    if len(sys.argv) != 2:
        print(json.dumps({'error': 'Ожидается один аргумент — путь к JSON-конфигу'}))
        sys.exit(1)
    with open(sys.argv[1], 'r', encoding='utf-8') as f:
        config = json.load(f)
    try:
        result = parse_excel(config['path'])
        print(json.dumps(result, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({'error': f'Не удалось прочитать Excel-файл: {exc}', 'errorCode': 'EXCEL_PARSE_FAILED'}))


if __name__ == '__main__':
    main()

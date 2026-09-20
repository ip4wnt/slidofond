import { h, mount } from './render.js';
import { svgIcon } from './icons.js';
import { attachUploadZone } from './upload.js';

// Экран генерации таблиц/графиков по промпту (Block 3). Мастер из 4 шагов:
//   1. Режим (таблица/график) + загрузка Excel с данными
//   2. Выбор данных: для таблицы — какие строки/колонки включить; для графика — какая
//      колонка категорий и какие колонки рядов
//   3. Источник стиля: приложить свой pptx-файл образец ИЛИ выбрать уже размеченный
//      тег из активного пространства
//   4. Результат: ссылка на скачивание готового .pptx, либо ошибка "данные не помещаются"
//      с конкретными числами и предложением сократить выборку
//
// Состояние экрана держим внутри модуля (аналогично public/js/modules/storage.js) —
// он самодостаточен и не пачкает общий app-store лишними полями мастера.
const wizardState = {
  step: 1,
  mode: 'table', // 'table' | 'chart'
  excelFile: null,
  excelSheets: null, // [{name, rows, rowCount, colCount}]
  activeSheetIndex: 0,
  excelError: null,
  excelLoading: false,

  // Выбор данных
  headerRowIndex: 0, // индекс строки-заголовка внутри листа (таблица)
  selectedRowIndices: [], // остальные строки данных, включённые в таблицу
  selectedColIndices: [], // колонки, включённые в таблицу/график
  categoryColIndex: null, // график: какая колонка — категории (обычно первая текстовая)
  seriesColIndices: [], // график: какие колонки — числовые ряды
  chartType: 'COLUMN_CLUSTERED',

  // Источник стиля
  styleMode: 'donorTag', // 'donorTag' | 'donorUpload'
  styleOptions: [],
  styleOptionsLoading: false,
  selectedTagId: null,
  donorFile: null,

  submitting: false,
  result: null, // { downloadUrl } | { errorMessage, capacity, requested }
};

function resetWizard() {
  Object.assign(wizardState, {
    step: 1,
    mode: 'table',
    excelFile: null,
    excelSheets: null,
    activeSheetIndex: 0,
    excelError: null,
    excelLoading: false,
    headerRowIndex: 0,
    selectedRowIndices: [],
    selectedColIndices: [],
    categoryColIndex: null,
    seriesColIndices: [],
    chartType: 'COLUMN_CLUSTERED',
    styleMode: 'donorTag',
    styleOptions: [],
    styleOptionsLoading: false,
    selectedTagId: null,
    donorFile: null,
    submitting: false,
    result: null,
  });
}

const CHART_TYPE_OPTIONS = [
  { value: 'COLUMN_CLUSTERED', label: 'Столбчатая' },
  { value: 'BAR_CLUSTERED', label: 'Линейчатая (горизонтальная)' },
  { value: 'LINE', label: 'Линия' },
  { value: 'LINE_MARKERS', label: 'Линия с маркерами' },
  { value: 'PIE', label: 'Круговая' },
  { value: 'AREA', label: 'С областями' },
];

export function renderGenerateScreen(container, actions) {
  const wrap = h('div', { class: 'generate-screen' }, [
    h('div', { class: 'generate-header' }, [
      h('button', { class: 'back-btn', onClick: actions.onBackHome, 'data-testid': 'button-generate-back' }, [
        svgIcon('back'),
        'На главную',
      ]),
      h('h1', {}, 'Генерация таблицы или графика'),
    ]),
    h('div', { class: 'generate-steps-indicator' }, [1, 2, 3, 4].map((n) =>
      h('div', { class: `step-dot ${wizardState.step === n ? 'active' : ''} ${wizardState.step > n ? 'done' : ''}` }, String(n))
    )),
    h('div', { class: 'generate-body', id: 'generate-step-slot' }),
  ]);
  mount(container, wrap);
  const slot = wrap.querySelector('#generate-step-slot');
  renderStep(slot, actions);
  return slot;
}

function renderStep(slot, actions) {
  if (wizardState.step === 1) return renderStep1(slot, actions);
  if (wizardState.step === 2) return renderStep2(slot, actions);
  if (wizardState.step === 3) return renderStep3(slot, actions);
  return renderStep4(slot, actions);
}

function rerender(slot, actions) {
  renderStep(slot, actions);
}

// ---------------------------------------------------------------------------
// Шаг 1 — режим + загрузка Excel
// ---------------------------------------------------------------------------

function renderStep1(slot, actions) {
  const modeToggle = h('div', { class: 'mode-toggle' }, [
    h('button', {
      class: `mode-toggle-btn ${wizardState.mode === 'table' ? 'active' : ''}`,
      onClick: () => { wizardState.mode = 'table'; rerender(slot, actions); },
      'data-testid': 'button-mode-table',
    }, 'Таблица'),
    h('button', {
      class: `mode-toggle-btn ${wizardState.mode === 'chart' ? 'active' : ''}`,
      onClick: () => { wizardState.mode = 'chart'; rerender(slot, actions); },
      'data-testid': 'button-mode-chart',
    }, 'График'),
  ]);

  const uploadZone = h('div', { class: 'upload-dropzone', id: 'excel-dropzone' }, [
    svgIcon('archive'),
    h('p', {}, wizardState.excelFile ? wizardState.excelFile.name : 'Перетащите Excel-файл (.xlsx) сюда или нажмите, чтобы выбрать'),
  ]);

  uploadZone.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.xlsx,.xls';
    input.addEventListener('change', () => {
      if (input.files && input.files[0]) handleExcelSelected(input.files[0], slot, actions);
    });
    input.click();
  });
  attachUploadZone(uploadZone, (files) => {
    if (files && files[0]) handleExcelSelected(files[0], slot, actions);
  });

  const body = [
    h('div', { class: 'field' }, [h('label', {}, 'Что нужно сгенерировать?'), modeToggle]),
    h('div', { class: 'field' }, [
      h('label', {}, 'Данные из Excel'),
      uploadZone,
      wizardState.excelLoading && h('div', { class: 'loading-row' }, [h('div', { class: 'spinner' }), 'Читаем файл…']),
      wizardState.excelError && h('div', { class: 'field-error' }, wizardState.excelError),
    ]),
    h('div', { class: 'generate-actions' }, [
      h('button', {
        class: 'btn btn-primary',
        disabled: !wizardState.excelSheets,
        onClick: () => { wizardState.step = 2; rerenderWholeScreen(actions); },
        'data-testid': 'button-generate-next-1',
      }, 'Далее — выбрать данные'),
    ]),
  ];

  mount(slot, h('div', { class: 'generate-step' }, body));
}

async function handleExcelSelected(file, slot, actions) {
  wizardState.excelFile = file;
  wizardState.excelLoading = true;
  wizardState.excelError = null;
  wizardState.excelSheets = null;
  rerender(slot, actions);
  try {
    const data = await actions.api.excelPreview(file);
    wizardState.excelSheets = data.sheets;
    wizardState.activeSheetIndex = 0;
    // Сбрасываем выбор данных на новых листах — по умолчанию заголовок = первая строка,
    // включены все остальные строки и все колонки, чтобы пользователю было от чего оттолкнуться.
    const sheet = data.sheets[0];
    if (sheet) {
      wizardState.headerRowIndex = 0;
      wizardState.selectedRowIndices = sheet.rows.slice(1).map((_, i) => i + 1);
      wizardState.selectedColIndices = Array.from({ length: sheet.colCount }, (_, i) => i);
      wizardState.categoryColIndex = 0;
      wizardState.seriesColIndices = sheet.colCount > 1 ? [1] : [];
    }
  } catch (err) {
    wizardState.excelError = err.message;
  } finally {
    wizardState.excelLoading = false;
    rerender(slot, actions);
  }
}

// ---------------------------------------------------------------------------
// Шаг 2 — выбор данных (строки/колонки для таблицы, категории/ряды для графика)
// ---------------------------------------------------------------------------

function currentSheet() {
  if (!wizardState.excelSheets) return null;
  return wizardState.excelSheets[wizardState.activeSheetIndex] || null;
}

function renderStep2(slot, actions) {
  const sheet = currentSheet();
  if (!sheet) {
    mount(slot, h('div', { class: 'generate-step' }, [h('p', {}, 'Файл не загружен.')]));
    return;
  }

  const sheetTabs = wizardState.excelSheets.length > 1
    ? h('div', { class: 'sheet-tabs' }, wizardState.excelSheets.map((s, i) =>
        h('button', {
          class: `sheet-tab ${i === wizardState.activeSheetIndex ? 'active' : ''}`,
          onClick: () => { wizardState.activeSheetIndex = i; rerender(slot, actions); },
        }, s.name)
      ))
    : null;

  const table = wizardState.mode === 'table'
    ? renderTableSelectionGrid(sheet, slot, actions)
    : renderChartSelectionGrid(sheet, slot, actions);

  const chartTypeField = wizardState.mode === 'chart'
    ? h('div', { class: 'field' }, [
        h('label', {}, 'Тип графика (если не задан явно — возьмём тип из образца стиля)'),
        h('select', {
          class: 'select-input',
          onChange: (e) => { wizardState.chartType = e.target.value; },
        }, CHART_TYPE_OPTIONS.map((opt) =>
          h('option', { value: opt.value, selected: opt.value === wizardState.chartType }, opt.label)
        )),
      ])
    : null;

  const canProceed = wizardState.mode === 'table'
    ? wizardState.selectedRowIndices.length > 0 && wizardState.selectedColIndices.length > 0
    : wizardState.categoryColIndex !== null && wizardState.seriesColIndices.length > 0;

  mount(slot, h('div', { class: 'generate-step' }, [
    sheetTabs,
    h('p', { class: 'field-hint' }, wizardState.mode === 'table'
      ? 'Отметьте строку заголовков, остальные строки и колонки, которые нужно включить в таблицу.'
      : 'Выберите колонку с категориями (например, «Квартал») и одну или несколько колонок с числовыми рядами.'),
    table,
    chartTypeField,
    h('div', { class: 'generate-actions' }, [
      h('button', { class: 'btn btn-secondary', onClick: () => { wizardState.step = 1; rerenderWholeScreen(actions); } }, 'Назад'),
      h('button', {
        class: 'btn btn-primary',
        disabled: !canProceed,
        onClick: () => { wizardState.step = 3; rerenderWholeScreen(actions); },
        'data-testid': 'button-generate-next-2',
      }, 'Далее — выбрать стиль'),
    ]),
  ]));
}

function renderTableSelectionGrid(sheet, slot, actions) {
  // Шапка с чекбоксами колонок строится по числу колонок текущего листа (не по строкам).
  const colCheckboxRow = h('tr', {}, [
    h('th', {}, 'Колонки →'),
    ...Array.from({ length: sheet.colCount }, (_, colIdx) =>
      h('th', {}, [
        h('label', { class: 'checkbox-label' }, [
          h('input', {
            type: 'checkbox',
            checked: wizardState.selectedColIndices.includes(colIdx),
            onChange: (e) => {
              if (e.target.checked) wizardState.selectedColIndices.push(colIdx);
              else wizardState.selectedColIndices = wizardState.selectedColIndices.filter((i) => i !== colIdx);
            },
          }),
          `#${colIdx + 1}`,
        ]),
      ])
    ),
  ]);

  const bodyRows = sheet.rows.map((row, rowIdx) => {
    const isHeader = rowIdx === wizardState.headerRowIndex;
    return h('tr', { class: isHeader ? 'row-is-header' : '' }, [
      h('td', { class: 'row-select-cell' }, [
        h('label', { class: 'checkbox-label' }, [
          h('input', {
            type: 'radio',
            name: 'header-row',
            checked: isHeader,
            onChange: () => {
              wizardState.headerRowIndex = rowIdx;
              wizardState.selectedRowIndices = wizardState.selectedRowIndices.filter((i) => i !== rowIdx);
              rerender(slot, actions);
            },
          }),
          'загол.',
          h('input', {
            type: 'checkbox',
            checked: !isHeader && wizardState.selectedRowIndices.includes(rowIdx),
            disabled: isHeader,
            onChange: (e) => {
              if (e.target.checked) wizardState.selectedRowIndices.push(rowIdx);
              else wizardState.selectedRowIndices = wizardState.selectedRowIndices.filter((i) => i !== rowIdx);
            },
          }),
          'вкл.',
        ]),
      ]),
      ...row.map((cell) => h('td', {}, cell)),
    ]);
  });

  return h('div', { class: 'excel-table-wrap' }, [
    h('table', { class: 'excel-preview-table' }, [
      h('thead', {}, [colCheckboxRow]),
      h('tbody', {}, bodyRows),
    ]),
  ]);
}

function renderChartSelectionGrid(sheet, slot, actions) {
  const colHeaderRow = h('tr', {}, [
    h('th', {}, 'Роль колонки →'),
    ...Array.from({ length: sheet.colCount }, (_, colIdx) =>
      h('th', {}, [
        h('div', { class: 'chart-col-role' }, [
          h('label', { class: 'checkbox-label' }, [
            h('input', {
              type: 'radio',
              name: 'category-col',
              checked: wizardState.categoryColIndex === colIdx,
              onChange: () => {
                wizardState.categoryColIndex = colIdx;
                wizardState.seriesColIndices = wizardState.seriesColIndices.filter((i) => i !== colIdx);
                rerender(slot, actions);
              },
            }),
            'категории',
          ]),
          h('label', { class: 'checkbox-label' }, [
            h('input', {
              type: 'checkbox',
              checked: wizardState.seriesColIndices.includes(colIdx),
              disabled: wizardState.categoryColIndex === colIdx,
              onChange: (e) => {
                if (e.target.checked) wizardState.seriesColIndices.push(colIdx);
                else wizardState.seriesColIndices = wizardState.seriesColIndices.filter((i) => i !== colIdx);
              },
            }),
            'ряд',
          ]),
        ]),
      ])
    ),
  ]);

  const bodyRows = sheet.rows.map((row, rowIdx) =>
    h('tr', { class: rowIdx === 0 ? 'row-is-header' : '' }, [
      h('td', { class: 'row-select-cell' }, String(rowIdx + 1)),
      ...row.map((cell) => h('td', {}, cell)),
    ])
  );

  return h('div', { class: 'excel-table-wrap' }, [
    h('table', { class: 'excel-preview-table' }, [
      h('thead', {}, [colHeaderRow]),
      h('tbody', {}, bodyRows),
    ]),
    h('p', { class: 'field-hint' }, 'Первая строка считается заголовками рядов; данные берутся начиная со второй строки.'),
  ]);
}

// ---------------------------------------------------------------------------
// Шаг 3 — источник стиля
// ---------------------------------------------------------------------------

function renderStep3(slot, actions) {
  if (wizardState.styleMode === 'donorTag' && wizardState.styleOptions.length === 0 && !wizardState.styleOptionsLoading) {
    loadStyleOptions(slot, actions);
  }

  const modeToggle = h('div', { class: 'mode-toggle' }, [
    h('button', {
      class: `mode-toggle-btn ${wizardState.styleMode === 'donorTag' ? 'active' : ''}`,
      onClick: () => { wizardState.styleMode = 'donorTag'; rerender(slot, actions); },
      'data-testid': 'button-style-from-space',
    }, 'Стиль из пространства'),
    h('button', {
      class: `mode-toggle-btn ${wizardState.styleMode === 'donorUpload' ? 'active' : ''}`,
      onClick: () => { wizardState.styleMode = 'donorUpload'; rerender(slot, actions); },
      'data-testid': 'button-style-upload',
    }, 'Загрузить файл-образец'),
  ]);

  let sourceBody;
  if (wizardState.styleMode === 'donorTag') {
    if (wizardState.styleOptionsLoading) {
      sourceBody = h('div', { class: 'loading-row' }, [h('div', { class: 'spinner' }), 'Ищем образцы стиля…']);
    } else if (wizardState.styleOptions.length === 0) {
      sourceBody = h('div', { class: 'empty-state-inline' }, `В текущем пространстве пока нет загруженных ${wizardState.mode === 'table' ? 'таблиц' : 'графиков'}. Загрузите файл-образец вместо этого.`);
    } else {
      sourceBody = h('div', { class: 'style-options-list' }, wizardState.styleOptions.map((opt) =>
        h('label', { class: `style-option-card ${wizardState.selectedTagId === opt.tagId ? 'selected' : ''}` }, [
          h('input', {
            type: 'radio',
            name: 'style-tag',
            checked: wizardState.selectedTagId === opt.tagId,
            onChange: () => { wizardState.selectedTagId = opt.tagId; rerender(slot, actions); },
          }),
          h('div', {}, [
            h('div', { class: 'style-option-title' }, opt.originalFilename),
            h('div', { class: 'style-option-desc' }, opt.label || `${opt.sourceKind}, слайд ${opt.slideIndex + 1}`),
          ]),
        ])
      ));
    }
  } else {
    const uploadZone = h('div', { class: 'upload-dropzone' }, [
      svgIcon('archive'),
      h('p', {}, wizardState.donorFile ? wizardState.donorFile.name : 'Перетащите .pptx с образцом стиля или нажмите, чтобы выбрать'),
    ]);
    uploadZone.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.pptx';
      input.addEventListener('change', () => {
        if (input.files && input.files[0]) { wizardState.donorFile = input.files[0]; rerender(slot, actions); }
      });
      input.click();
    });
    attachUploadZone(uploadZone, (files) => {
      if (files && files[0]) { wizardState.donorFile = files[0]; rerender(slot, actions); }
    });
    sourceBody = uploadZone;
  }

  const canProceed = wizardState.styleMode === 'donorTag' ? !!wizardState.selectedTagId : !!wizardState.donorFile;

  mount(slot, h('div', { class: 'generate-step' }, [
    h('div', { class: 'field' }, [h('label', {}, 'Откуда взять стиль оформления?'), modeToggle]),
    sourceBody,
    h('div', { class: 'generate-actions' }, [
      h('button', { class: 'btn btn-secondary', onClick: () => { wizardState.step = 2; rerenderWholeScreen(actions); } }, 'Назад'),
      h('button', {
        class: 'btn btn-primary',
        disabled: !canProceed,
        onClick: () => submitGeneration(slot, actions),
        'data-testid': 'button-generate-submit',
      }, 'Сгенерировать слайд'),
    ]),
  ]));
}

async function loadStyleOptions(slot, actions) {
  wizardState.styleOptionsLoading = true;
  rerender(slot, actions);
  try {
    const data = await actions.api.styleOptions(wizardState.mode, actions.getSpaceId());
    wizardState.styleOptions = data.options;
    if (data.options.length > 0) wizardState.selectedTagId = data.options[0].tagId;
  } catch {
    wizardState.styleOptions = [];
  } finally {
    wizardState.styleOptionsLoading = false;
    rerender(slot, actions);
  }
}

// ---------------------------------------------------------------------------
// Отправка + шаг 4 — результат
// ---------------------------------------------------------------------------

function buildPayload() {
  const sheet = currentSheet();
  const payload = {
    mode: wizardState.mode,
    spaceId: null, // проставляется в submitGeneration через actions.getSpaceId()
    style: wizardState.styleMode === 'donorTag'
      ? { mode: 'donorTag', tagId: wizardState.selectedTagId }
      : { mode: 'donorUpload' },
  };

  if (wizardState.mode === 'table') {
    const headerRow = sheet.rows[wizardState.headerRowIndex] || [];
    const cols = wizardState.selectedColIndices.slice().sort((a, b) => a - b);
    const orderedRowIndices = wizardState.selectedRowIndices.slice().sort((a, b) => a - b);
    payload.table = {
      headers: cols.map((c) => headerRow[c] || `Колонка ${c + 1}`),
      rows: orderedRowIndices.map((r) => cols.map((c) => sheet.rows[r][c] || '')),
    };
  } else {
    const catCol = wizardState.categoryColIndex;
    const categories = sheet.rows.slice(1).map((row) => row[catCol] || '');
    const series = wizardState.seriesColIndices.map((colIdx) => ({
      name: sheet.rows[0][colIdx] || `Ряд ${colIdx + 1}`,
      values: sheet.rows.slice(1).map((row) => Number(row[colIdx]) || 0),
    }));
    payload.chart = { chartType: wizardState.chartType, categories, series };
  }
  return payload;
}

async function submitGeneration(slot, actions) {
  wizardState.submitting = true;
  wizardState.step = 4;
  wizardState.result = null;
  rerenderWholeScreen(actions);
  try {
    const payload = buildPayload();
    payload.spaceId = actions.getSpaceId();
    const donorFile = wizardState.styleMode === 'donorUpload' ? wizardState.donorFile : null;
    const data = await actions.api.generateContent(payload, donorFile);
    wizardState.result = { success: true, downloadUrl: actions.api.generateDownloadUrl(data.id) };
  } catch (err) {
    let errorMessage = err.message;
    if (err.errorCode === 'TOO_LARGE' && err.capacity && err.requested) {
      if (wizardState.mode === 'table') {
        errorMessage = `${err.message} Максимум для этого образца стиля: ${err.capacity.maxRows} строк × ${err.capacity.maxCols} колонок (шрифт ≈${err.capacity.fontPt}pt). Запрошено: ${err.requested.rows} строк × ${err.requested.cols} колонок. Сократите выборку данных.`;
      } else {
        errorMessage = `${err.message} Максимум для этого образца стиля: ${err.capacity.maxCategories} категорий, ${err.capacity.maxSeries} рядов. Запрошено: ${err.requested.categories} категорий, ${err.requested.series} рядов. Сократите выборку данных.`;
      }
    }
    wizardState.result = {
      success: false,
      errorMessage,
      errorCode: err.errorCode,
    };
  } finally {
    wizardState.submitting = false;
    rerenderWholeScreen(actions);
  }
}

function renderStep4(slot, actions) {
  if (wizardState.submitting || !wizardState.result) {
    mount(slot, h('div', { class: 'generate-step' }, [
      h('div', { class: 'loading-row' }, [h('div', { class: 'spinner' }), 'Собираем слайд…']),
    ]));
    return;
  }

  if (wizardState.result.success) {
    mount(slot, h('div', { class: 'generate-step' }, [
      h('div', { class: 'build-result-card' }, [
        svgIcon('layers'),
        h('h2', {}, 'Слайд готов'),
        h('p', {}, 'Скачайте готовый .pptx-файл со сгенерированным слайдом в стиле выбранного образца.'),
        h('a', { class: 'btn btn-primary', href: wizardState.result.downloadUrl, download: true, 'data-testid': 'link-download-generated' }, [
          svgIcon('download'), 'Скачать слайд',
        ]),
      ]),
      h('div', { class: 'generate-actions' }, [
        h('button', { class: 'btn btn-secondary', onClick: () => { resetWizard(); rerenderWholeScreen(actions); } }, 'Сгенерировать ещё один'),
      ]),
    ]));
    return;
  }

  const isTooLarge = wizardState.result.errorCode === 'TOO_LARGE';
  mount(slot, h('div', { class: 'generate-step' }, [
    h('div', { class: 'field-error-card' }, [
      h('h3', {}, isTooLarge ? 'Данные не помещаются на слайд' : 'Не удалось сгенерировать слайд'),
      h('p', {}, wizardState.result.errorMessage),
    ]),
    h('div', { class: 'generate-actions' }, [
      h('button', { class: 'btn btn-secondary', onClick: () => { wizardState.step = 2; wizardState.result = null; rerenderWholeScreen(actions); } }, 'Изменить выбор данных'),
      h('button', { class: 'btn btn-secondary', onClick: () => { resetWizard(); rerenderWholeScreen(actions); } }, 'Начать заново'),
    ]),
  ]));
}

function rerenderWholeScreen(actions) {
  actions.onRerenderScreen();
}

export function initGenerateWizard() {
  resetWizard();
}

// Предзаполнение при переходе из строки поиска (намерение generate_table/generate_chart
// уже распознано на сервере и, если получилось, там же подобран styleReference — см.
// server/routes/search.js). Пользователь всё равно должен пройти шаг 1 (приложить Excel),
// т.к. в самой строке поиска файла нет — но режим и стиль выставляем заранее, чтобы не
// заставлять его повторять выбор, который уже сделан по смыслу запроса.
export function prefillGenerateMode(mode) {
  wizardState.mode = mode;
}

export function prefillGenerateFromSearch(mode, styleReference) {
  wizardState.mode = mode;
  wizardState.styleMode = 'donorTag';
  wizardState.selectedTagId = styleReference.tagId;
  wizardState.styleOptions = [{
    tagId: styleReference.tagId,
    originalFilename: styleReference.originalFilename,
    slideIndex: styleReference.slideIndex,
    shapeIndex: styleReference.shapeIndex,
    sourceKind: styleReference.sourceKind,
    chartType: styleReference.chartType,
    label: styleReference.label,
  }];
}

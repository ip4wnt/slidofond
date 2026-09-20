import { h } from './render.js';
import { svgIcon } from './icons.js';
import { formatBytes, formatDate, formatDateTime } from './format.js';

const STATUS_LABELS = { pending: 'В очереди', processing: 'Анализ…', done: 'Готово', error: 'Ошибка анализа' };

// Рендерит список презентаций в текущей папке.
// presentations: [{...}], uploads: [{localId, fileName, progress, phase, errorMessage}], expandedId: id | null, currentUser: {id, role}
// actions: { onToggleExpand, onDownload, onDelete, onOpenGallery, onSaveSummary, onSaveSlideDescription, onUploadClick, onDismissUpload }
export function renderFileList(container, { presentations, uploads, expandedId, currentUser, canEdit }, actions) {
  const uploadCards = (uploads || []).map((u) => renderUploadCard(u, actions));

  if (presentations.length === 0) {
    if (uploadCards.length > 0) {
      container.replaceChildren(h('div', { class: 'file-list' }, uploadCards));
      return;
    }
    container.replaceChildren(
      h('div', { class: 'empty-state' }, [
        svgIcon('fileText'),
        h('p', {}, 'В этой папке пока нет презентаций.'),
        canEdit &&
          h('button', { class: 'btn btn-primary', onClick: actions.onUploadClick, 'data-testid': 'button-upload-empty' }, [
            svgIcon('upload'),
            'Загрузить презентацию',
          ]),
      ])
    );
    return;
  }

  const list = h('div', { class: 'file-list' }, [
    ...uploadCards,
    ...presentations.map((p) => renderFileCard(p, expandedId === p.id, currentUser, canEdit, actions)),
  ]);
  container.replaceChildren(list);
}

const UPLOAD_PHASE_LABELS = {
  uploading: 'Загрузка…',
  processing: 'Анализ…',
  error: 'Ошибка',
};

function renderUploadCard(u, actions) {
  const percent = Math.round((u.progress || 0) * 100);
  const isError = u.phase === 'error';

  return h('div', { class: `upload-card${isError ? ' upload-card-error' : ''}`, 'data-testid': `upload-card-${u.localId}` }, [
    h('div', { class: 'upload-card-icon' }, [svgIcon(isError ? 'alertCircle' : 'fileText')]),
    h('div', { class: 'upload-card-body' }, [
      h('div', { class: 'upload-card-title', title: u.fileName }, u.fileName),
      isError
        ? h('div', { class: 'upload-card-error-text' }, u.errorMessage || 'Не удалось загрузить файл')
        : h('div', { class: 'upload-card-progress-row' }, [
            h('div', { class: 'upload-card-progress-track' }, [
              h('div', {
                class: 'upload-card-progress-fill',
                style: `width:${u.phase === 'processing' ? 100 : percent}%`,
              }),
            ]),
            h('span', { class: 'upload-card-phase' }, u.phase === 'uploading' ? `${UPLOAD_PHASE_LABELS.uploading} ${percent}%` : UPLOAD_PHASE_LABELS.processing),
          ]),
    ]),
    isError &&
      h('button', { class: 'icon-btn', 'aria-label': 'Скрыть', onClick: () => actions.onDismissUpload(u.localId), 'data-testid': `button-dismiss-upload-${u.localId}` }, [
        svgIcon('x') ,
      ]),
  ]);
}

function renderFileCard(p, isExpanded, currentUser, canEdit, actions) {
  const canDelete = currentUser.role === 'admin' || (canEdit && p.uploadedBy === currentUser.id);
  const firstSlidePreview = `/api/presentations/${p.id}/slides/0/preview`;

  const main = h('div', { class: 'file-card-main' }, [
    h(
      'div',
      { class: 'file-card-thumb', onClick: () => actions.onOpenGallery(p) },
      p.slideCount > 0 ? [h('img', { src: firstSlidePreview, loading: 'lazy', alt: 'Превью' })] : [svgIcon('fileText')]
    ),
    h('div', { class: 'file-card-body' }, [
      h('div', { class: 'file-card-title', title: p.originalFilename }, p.originalFilename),
      p.summaryText && h('div', { class: 'file-card-summary' }, truncate(p.summaryText, 220)),
      h(
        'button',
        { class: 'file-card-meta-toggle', onClick: () => actions.onToggleExpand(p.id), 'data-testid': `button-expand-${p.id}` },
        [
          'Метаданные',
          (() => {
            const el = svgIcon('chevronDown');
            el.style.transform = isExpanded ? 'rotate(180deg)' : 'none';
            return el;
          })(),
        ]
      ),
    ]),
    h('div', { class: 'file-card-side' }, [
      h('div', { class: 'file-card-meta' }, [
        h('span', {}, ['Изменён: ', h('b', {}, formatDate(p.fileModifiedAt))]),
        h('span', {}, ['Загружен: ', h('b', {}, formatDate(p.uploadedAt))]),
        h('span', {}, ['Загрузил: ', h('b', {}, p.uploadedByName)]),
        h('span', {}, h('b', {}, formatBytes(p.fileSizeBytes))),
        h('span', {}, ['Слайдов: ', h('b', {}, p.slideCount)]),
        h(
          'span',
          {
            class: `status-pill ${p.summaryStatus}`,
            title: p.summaryStatus === 'error' && p.errorMessage ? p.errorMessage : undefined,
          },
          STATUS_LABELS[p.summaryStatus] || p.summaryStatus
        ),
      ]),
      h('div', { class: 'file-card-actions' }, [
        h('a', { class: 'icon-btn', href: actions.downloadUrl(p.id), 'aria-label': 'Скачать', 'data-testid': `button-download-${p.id}` }, [svgIcon('download')]),
        canDelete &&
          h('button', { class: 'icon-btn btn-danger', 'aria-label': 'Удалить', onClick: () => actions.onDelete(p), 'data-testid': `button-delete-${p.id}` }, [
            svgIcon('trash'),
          ]),
      ]),
    ]),
  ]);

  const expandPanel = isExpanded ? renderExpandPanel(p, canEdit, actions) : null;

  return h('div', { class: 'file-card', 'data-testid': `file-card-${p.id}` }, [main, expandPanel]);
}

function renderExpandPanel(p, canEdit, actions) {
  const summaryBox = h('div', { class: 'summary-edit-box' }, [
    h('label', { style: 'font-size:var(--text-xs);font-weight:600;color:var(--color-text-muted);' }, 'Описание всей презентации'),
    canEdit
      ? h('textarea', {
          class: 'summary-textarea',
          value: p.summaryText,
          'data-testid': `textarea-summary-${p.id}`,
          onBlur: (e) => {
            if (e.target.value !== p.summaryText) actions.onSaveSummary(p.id, e.target.value);
          },
        })
      : h('div', { class: 'file-card-summary' }, p.summaryText || '(описание отсутствует)'),
  ]);

  const slidesBox = h(
    'div',
    { class: 'slides-desc-list' },
    (p.slides || []).map((s) =>
      h('div', { class: 'slide-desc-row' }, [
        h('div', { class: 'slide-desc-thumb', onClick: () => actions.onOpenGallery(p, s.index) }, [
          h('img', { src: s.previewUrl, loading: 'lazy', alt: `Слайд ${s.index + 1}` }),
        ]),
        h('div', { class: 'slide-desc-text' }, [
          h('div', { style: 'font-size:var(--text-xs);color:var(--color-text-faint);margin-bottom:4px;' }, [
            `Слайд ${s.index + 1}`,
            s.descriptionEdited ? h('span', { class: 'edited-badge' }, ' · отредактировано') : null,
          ]),
          renderContentTags(s.contentTags),
          canEdit
            ? h('textarea', {
                class: 'slide-desc-input',
                value: s.description,
                'data-testid': `textarea-slide-${s.id}`,
                onBlur: (e) => {
                  if (e.target.value !== s.description) actions.onSaveSlideDescription(s.id, e.target.value, p.id);
                },
              })
            : h('div', {}, s.description),
        ]),
      ])
    )
  );

  return h('div', { class: 'file-card-expand' }, [summaryBox, slidesBox]);
}

const CONTENT_TYPE_ICON = { table: 'table', chart: 'barChart' };
const SOURCE_KIND_LABEL = {
  native: '',
  imitation: ' (имитация блоками)',
  image: ' (картинка)',
};

const CHART_TYPE_RU = {
  COLUMN_CLUSTERED: 'столбчатая',
  COLUMN_STACKED: 'столбчатая с накоплением',
  BAR_CLUSTERED: 'гистограмма',
  BAR_STACKED: 'гистограмма с накоплением',
  LINE: 'линейная',
  LINE_MARKERS: 'линейная с маркерами',
  PIE: 'круговая',
  DOUGHNUT: 'кольцевая',
  AREA: 'с областями',
  XY_SCATTER: 'точечная',
  RADAR: 'лепестковая',
  UNKNOWN: 'тип не определён уверенно',
};

function emuToCm(emu) {
  if (!emu && emu !== 0) return null;
  return (emu / 360000).toFixed(1);
}

function fmtFont(font) {
  if (!font || !font.name) return null;
  const parts = [font.name];
  if (font.size) parts.push(`${Math.round(font.size)}pt`);
  const extra = [];
  if (font.bold) extra.push('полужирный');
  if (font.italic) extra.push('курсив');
  if (font.color) extra.push(font.color);
  let text = parts.join(' ');
  if (extra.length) text += ', ' + extra.join(', ');
  return text;
}

// Строит подробный список человекочитаемых пунктов описания стиля из style_payload —
// показывается при клике на бейдж тега. Набор пунктов зависит от contentType/sourceKind,
// так как у каждого источника свой набор извлечённых атрибутов.
function styleDetailsFromTag(tag) {
  const sp = tag.stylePayload || {};
  const lines = [];

  if (tag.contentType === 'table' && tag.sourceKind === 'native') {
    lines.push(`Размер: ${sp.rows}×${sp.cols} ячеек`);
    if (sp.headerFill) lines.push(`Заливка шапки: ${sp.headerFill}`);
    const headerFont = fmtFont(sp.headerFont);
    if (headerFont) lines.push(`Шрифт шапки: ${headerFont}`);
    else if (sp.headerFont && (sp.headerFont.color || sp.headerFont.bold)) {
      const extra = [sp.headerFont.bold ? 'полужирный' : null, sp.headerFont.color].filter(Boolean);
      if (extra.length) lines.push(`Текст шапки: ${extra.join(', ')}`);
    }
    if (sp.bodyFill) lines.push(`Заливка тела: ${sp.bodyFill}`);
    const bodyFont = fmtFont(sp.bodyFont);
    if (bodyFont) lines.push(`Шрифт тела: ${bodyFont}`);
    if (sp.bandingEnabled) lines.push(`Чередование строк (zebra): да${sp.bandFill ? `, цвет ${sp.bandFill}` : ''}`);
    if (sp.bordersVisible === true) lines.push('Границы ячеек: видимы');
    else if (sp.bordersVisible === false) lines.push('Границы ячеек: скрыты');
    if (sp.widthEmu && sp.heightEmu) lines.push(`Размер блока: ${emuToCm(sp.widthEmu)}×${emuToCm(sp.heightEmu)} см`);
  } else if (tag.contentType === 'table' && tag.sourceKind === 'imitation') {
    lines.push(`Размер сетки: ${sp.rows}×${sp.cols} (${sp.blockCount} блоков)`);
    if (sp.dominantFill) lines.push(`Основная заливка блоков: ${sp.dominantFill}`);
    if (sp.distinctFills && sp.distinctFills.length > 1) lines.push(`Встречающиеся цвета: ${sp.distinctFills.join(', ')}`);
    const sampleFont = fmtFont(sp.sampleFont);
    if (sampleFont) lines.push(`Шрифт ячеек: ${sampleFont}`);
    if (sp.alignment) lines.push(`Выравнивание текста: ${sp.alignment}`);
    if (sp.avgBlockWidthEmu && sp.avgBlockHeightEmu) {
      lines.push(`Средний размер ячейки: ${emuToCm(sp.avgBlockWidthEmu)}×${emuToCm(sp.avgBlockHeightEmu)} см`);
    }
    lines.push('Примечание: это не нативная PPT-таблица, а сетка из текстовых блоков');
  } else if (tag.contentType === 'chart' && tag.sourceKind === 'native') {
    const chartTypeRu = CHART_TYPE_RU[sp.chartType] || sp.chartType || 'тип не определён';
    lines.push(`Тип графика: ${chartTypeRu}`);
    if (sp.seriesColors && sp.seriesColors.length) lines.push(`Цвета рядов: ${sp.seriesColors.join(', ')}`);
    if (sp.seriesCount) lines.push(`Число рядов: ${sp.seriesCount}`);
    if (sp.categoryCount) lines.push(`Число категорий: ${sp.categoryCount}`);
    lines.push(`Легенда: ${sp.hasLegend ? 'есть' : 'нет'}`);
    lines.push(`Заголовок: ${sp.hasTitle ? 'есть' : 'нет'}`);
    if (sp.gapWidth !== undefined && sp.gapWidth !== null) lines.push(`Зазор между столбцами: ${sp.gapWidth}%`);
    if (sp.widthEmu && sp.heightEmu) lines.push(`Размер блока: ${emuToCm(sp.widthEmu)}×${emuToCm(sp.heightEmu)} см`);
    if (sp.extractedVia === 'xml_fallback') lines.push('Стиль извлечён напрямую из XML графика (нестандартный формат chart-части)');
    if (!sp.chartType && !sp.seriesColors) lines.push('Детали стиля недоступны для чтения');
  } else if (tag.contentType === 'chart' && tag.sourceKind === 'image') {
    const chartTypeRu = CHART_TYPE_RU[sp.chartType] || sp.chartType || 'тип не определён';
    lines.push(`Предполагаемый тип (по OpenCV-эвристике): ${chartTypeRu}`);
    if (sp.seriesPalette && sp.seriesPalette.length) lines.push(`Палитра серий/секторов: ${sp.seriesPalette.join(', ')}`);
    if (sp.backgroundColor) lines.push(`Фон: ${sp.backgroundColor}`);
    if (sp.dominantColors && sp.dominantColors.length) lines.push(`Общая доминирующая палитра: ${sp.dominantColors.join(', ')}`);
    if (sp.signals) {
      const s = sp.signals;
      lines.push(`Признаки: покрытие ${Math.round((s.coverage || 0) * 100)}%, прямоугольных блоков ${s.rectLike || 0}, круглых/секторов ${s.circleLike || 0}`);
    }
    lines.push(`Уверенность распознавания: ${Math.round((tag.confidence || 0) * 100)}%`);
    lines.push('Примечание: график вставлен как картинка, точные данные из него не извлекаемы');
  }

  if (lines.length === 0) return [tag.label || 'Описание стиля недоступно'];
  return lines;
}

// Рендерит теги таблиц/графиков, найденных на слайде: бейджи в разметке контента,
// по клику на бейдж — разворачивается подробный список атрибутов стиля.
function renderContentTags(tags) {
  if (!tags || tags.length === 0) return null;

  return h(
    'div',
    { class: 'content-tags-list' },
    tags.map((tag) => {
      const badge = h('button', { type: 'button', class: `content-tag-badge content-tag-${tag.contentType}` }, [
        svgIcon(CONTENT_TYPE_ICON[tag.contentType] || 'fileText'),
        h('span', {}, (tag.contentType === 'table' ? 'Таблица' : 'График') + (SOURCE_KIND_LABEL[tag.sourceKind] || '')),
        svgIcon('chevronDown'),
      ]);
      const detailItems = styleDetailsFromTag(tag).map((line) => h('li', {}, line));
      const detail = h('div', { class: 'content-tag-detail' }, [h('ul', { class: 'content-tag-detail-list' }, detailItems)]);
      const wrap = h('div', { class: 'content-tag-item' }, [badge, detail]);
      badge.addEventListener('click', () => wrap.classList.toggle('is-open'));
      return wrap;
    })
  );
}

function truncate(text, len) {
  if (!text || text.length <= len) return text;
  return text.slice(0, len).trimEnd() + '…';
}

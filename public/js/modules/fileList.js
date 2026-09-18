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

function truncate(text, len) {
  if (!text || text.length <= len) return text;
  return text.slice(0, len).trimEnd() + '…';
}

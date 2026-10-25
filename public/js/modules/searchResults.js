import { h, mount } from './render.js';
import { svgIcon } from './icons.js';

// Определяет, является ли запрос "сборкой презентации" (а не поиском одного слайда).
// Эвристика: содержит глаголы сборки/наличие перечисления через "и"/запятые, либо явные ключевые слова.
export function isBuildRequest(query) {
  const q = query.toLowerCase();
  const buildTriggers = [
    'собери', 'собрать', 'сформируй', 'составь', 'сделай презентацию', 'сделай презу',
    'собери презентацию', 'подготовь презентацию',
  ];
  return buildTriggers.some((t) => q.includes(t));
}

export function renderLoading(slot, label = 'Ищем подходящие слайды…') {
  mount(slot, h('div', { class: 'loading-row' }, [h('div', { class: 'spinner' }), label]));
}

// Подпись о контексте использования, если он есть у результата (событие · докладчик · место).
function usageLine(usage) {
  if (!usage) return '';
  return [usage.event, usage.speaker, usage.place, usage.date].filter(Boolean).join(' · ');
}

export function renderSearchResults(slot, { query, intent, slides, presentations, context }, actions) {
  const items = intent === 'presentation' ? presentations || [] : slides || [];
  const countLabel = intent === 'presentation' ? `Найдено презентаций: ${items.length}` : `Найдено слайдов: ${items.length}`;
  // Если часть запроса распознана как контекст (докладчик, площадка, событие) — говорим об этом явно.
  const contextWords = (context && context.contextWords) || [];
  const topicWords = (context && context.topicWords) || [];
  const contextNote = contextWords.length
    ? h('div', { class: 'context-note', 'data-testid': 'context-note' }, [
        'Учтен контекст использования: ',
        h('b', {}, contextWords.join(', ')),
        topicWords.length ? ` — тема: ${topicWords.join(', ')}` : '',
      ])
    : null;

  const header = h('div', { class: 'results-header' }, [
    h('button', { class: 'back-btn', onClick: actions.onBackHome, 'data-testid': 'button-back-home' }, [
      svgIcon('back'),
      'На главную',
    ]),
    h('div', { class: 'results-meta' }, countLabel),
  ]);

  if (items.length === 0) {
    mount(
      slot,
      h('div', {}, [
        header,
        h('div', { class: 'empty-state' }, [
          svgIcon('search'),
          h('p', {}, `По запросу «${query}» ничего не найдено. Попробуйте переформулировать запрос.`),
        ]),
      ])
    );
    return;
  }

  const grid =
    intent === 'presentation'
      ? renderPresentationGrid(items, actions)
      : renderSlideGrid(items, actions);

  mount(slot, h('div', {}, [header, contextNote, grid]));
}

function renderSlideGrid(slides, actions) {
  return h(
    'div',
    { class: 'slide-grid' },
    slides.map((slide) =>
      h('div', { class: 'slide-card', 'data-testid': `card-slide-${slide.slideId}` }, [
        h(
          'div',
          { class: 'slide-thumb', onClick: () => actions.onPreviewSlide(slide) },
          [h('img', { src: slide.previewUrl, loading: 'lazy', alt: slide.title || 'Превью слайда' })]
        ),
        h('div', { class: 'slide-card-body' }, [
          h('div', { class: 'slide-card-title' }, slide.title || 'Без названия'),
          h('div', { class: 'slide-card-desc' }, slide.description || ''),
          h('div', { class: 'slide-card-source' }, `Из файла: ${slide.originalFilename}`),
          usageLine(slide.usage) && h('div', { class: 'slide-card-usage' }, usageLine(slide.usage)),
        ]),
        h('div', { class: 'slide-card-actions' }, [
          h(
            'button',
            {
              class: 'btn btn-secondary btn-sm',
              onClick: () => actions.onCopySlide(slide),
              'data-testid': `button-copy-${slide.slideId}`,
            },
            [svgIcon('copy'), 'Скопировать']
          ),
        ]),
      ])
    )
  );
}

// Карточки для результатов типа "презентация" (когда пользователь искал всю презентацию, а не слайд).
function renderPresentationGrid(presentations, actions) {
  return h(
    'div',
    { class: 'slide-grid' },
    presentations.map((p) =>
      h('div', { class: 'slide-card', 'data-testid': `card-presentation-${p.presentationId}` }, [
        h(
          'div',
          { class: 'slide-thumb', onClick: () => actions.onOpenPresentation(p) },
          [h('img', { src: p.previewUrl, loading: 'lazy', alt: p.originalFilename || 'Превью презентации' })]
        ),
        h('div', { class: 'slide-card-body' }, [
          h('div', { class: 'slide-card-title' }, p.originalFilename || 'Без названия'),
          h('div', { class: 'slide-card-desc' }, p.summaryText || ''),
          h('div', { class: 'slide-card-source' }, `Слайдов: ${p.slideCount || 0}`),
          usageLine(p.usage) && h('div', { class: 'slide-card-usage' }, usageLine(p.usage)),
        ]),
        h('div', { class: 'slide-card-actions' }, [
          h(
            'button',
            { class: 'btn btn-secondary btn-sm', onClick: () => actions.onOpenPresentation(p), 'data-testid': `button-view-${p.presentationId}` },
            [svgIcon('search'), 'Просмотреть']
          ),
          h(
            'button',
            { class: 'btn btn-primary btn-sm', onClick: () => actions.onDownloadPresentation(p), 'data-testid': `button-download-${p.presentationId}` },
            [svgIcon('download'), 'Скачать']
          ),
        ]),
      ])
    )
  );
}

export function renderBuildResult(slot, { query, downloadUrl, slideCount, expiresAt }, actions) {
  const header = h('div', { class: 'results-header' }, [
    h('button', { class: 'back-btn', onClick: actions.onBackHome, 'data-testid': 'button-back-home' }, [
      svgIcon('back'),
      'На главную',
    ]),
  ]);

  const expiresText = expiresAt
    ? new Date(expiresAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '';

  mount(
    slot,
    h('div', {}, [
      header,
      h('div', { class: 'build-result-card' }, [
        svgIcon('layers'),
        h('h2', {}, `Презентация собрана из ${slideCount} слайдов`),
        h('p', {}, `По запросу: «${query}». Файл будет храниться на сервере до ${expiresText}, затем автоматически удалится.`),
        h(
          'a',
          { class: 'btn btn-primary', href: downloadUrl, download: true, 'data-testid': 'button-download-build' },
          [svgIcon('download'), 'Скачать презентацию']
        ),
      ]),
    ])
  );
}

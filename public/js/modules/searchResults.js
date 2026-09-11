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

export function renderSearchResults(slot, { query, slides }, actions) {
  const header = h('div', { class: 'results-header' }, [
    h('button', { class: 'back-btn', onClick: actions.onBackHome, 'data-testid': 'button-back-home' }, [
      svgIcon('back'),
      'На главную',
    ]),
    h('div', { class: 'results-meta' }, `Найдено слайдов: ${slides.length}`),
  ]);

  if (slides.length === 0) {
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

  const grid = h(
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

  mount(slot, h('div', {}, [header, grid]));
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

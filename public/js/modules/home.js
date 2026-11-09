import { h, mount } from './render.js';
import { svgIcon, spaceIcon } from './icons.js';

// Главная по макету Figma (страница 1-136): строка поиска с золотой стрелкой, под ней
// режимы «Найти слайд» / «Найти презентацию», внизу экрана — пять пространств. Возвращает слот для результатов поиска.
export function renderHome(container, { spaces, activeSpaceId, view, query, searchMode }, { onSelectSpace, onSubmitSearch, onSetSearchMode }) {
  const isIdle = view === 'idle';

  const input = h('input', {
    type: 'text', class: 'search-input', placeholder: 'Что будем искать?', value: query || '',
    'data-testid': 'input-search', autocomplete: 'off', 'aria-label': 'Поисковый запрос',
  });

  const submit = () => {
    const value = input.value.trim();
    if (value) onSubmitSearch(value);
  };

  const searchBox = h('div', { class: 'search-box-wrap' }, [
    h('form', { class: 'search-box', onSubmit: (e) => { e.preventDefault(); submit(); } }, [
      input,
      h('button', { type: 'submit', class: 'search-submit-btn', 'aria-label': 'Искать', 'data-testid': 'button-search' }, [svgIcon('arrowGo')]),
    ]),
  ]);

  const modes = [
    { id: 'slide', label: 'Найти слайд' },
    { id: 'presentation', label: 'Найти презентацию' },
  ];
  const modeRow = h('div', { class: 'mode-row', role: 'group', 'aria-label': 'Режим поиска' }, modes.map((m) =>
    h('button', {
      type: 'button',
      class: `pill mode-pill${searchMode === m.id ? ' active' : ''}`,
      'aria-pressed': searchMode === m.id ? 'true' : 'false',
      disabled: !!m.disabled,
      title: m.title || null,
      'data-testid': `mode-${m.id}`,
      onClick: () => { if (!m.disabled) onSetSearchMode(m.id); },
    }, m.label)
  ));

  const resultsSlot = h('div', { class: 'results-area' });

  const spacesRow = h('div', { class: 'spaces-row', role: 'group', 'aria-label': 'Пространства' }, spaces.map((space) =>
    h('button', {
      class: `pill space-circle${space.id === activeSpaceId ? ' active' : ''}`,
      title: space.name,
      'aria-label': space.name,
      'aria-pressed': space.id === activeSpaceId ? 'true' : 'false',
      onClick: () => onSelectSpace(space.id),
      'data-testid': `space-${space.slug}`,
    }, [spaceIcon(space.icon)])
  ));

  const view_ = h('div', { class: `home-view ${isIdle ? 'centered' : 'top-aligned'}` }, [
    h('div', { class: 'home-search-block' }, [searchBox, modeRow]),
    !isIdle && resultsSlot,
    isIdle && h('div', { class: 'home-spacer' }),
    spacesRow,
  ]);

  mount(container, view_);
  if (isIdle) setTimeout(() => input.focus(), 0);
  return resultsSlot;
}

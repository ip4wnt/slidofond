import { h, mount } from './render.js';
import { svgIcon, spaceIcon } from './icons.js';

// Рендерит главный экран: заголовок, круглые кнопки-переключатели пространств, строку поиска и кнопку хранилища.
// Пространства — это вкладки с одинственным выбором: поиск и архив всегда ведутся только в одном активном пространстве.
// state: { spaces, activeSpaceId, view: 'idle'|'results', query }
// actions: { onSelectSpace, onSubmitSearch, onOpenStorage }
export function renderHome(container, state, actions) {
  const isTop = state.view !== 'idle';

  const spacesRow = h(
    'div',
    { class: 'spaces-row', role: 'tablist' },
    state.spaces.map((space) =>
      h(
        'button',
        {
          class: `space-circle ${space.id === state.activeSpaceId ? 'active' : ''}`,
          onClick: () => actions.onSelectSpace(space.id),
          role: 'tab',
          'aria-selected': space.id === state.activeSpaceId ? 'true' : 'false',
          'aria-label': space.name,
          title: space.name,
          'data-testid': `space-pill-${space.slug}`,
        },
        [spaceIcon(space.icon)]
      )
    )
  );

  const searchForm = h(
    'form',
    {
      class: 'search-box',
      onSubmit: (e) => {
        e.preventDefault();
        const input = e.target.querySelector('input');
        actions.onSubmitSearch(input.value.trim());
      },
    },
    [
      h('input', {
        class: 'search-input',
        type: 'text',
        placeholder: 'Здравствуйте! Чем могу Вам помочь?',
        value: state.query || '',
        'data-testid': 'input-search',
      }),
      h('button', { class: 'search-submit-btn', type: 'submit', 'aria-label': 'Найти', 'data-testid': 'button-search' }, [
        svgIcon('sendArrow'),
      ]),
    ]
  );

  const view = h(
    'div',
    { class: `home-view ${isTop ? 'top-aligned' : 'centered'}` },
    [
      !isTop &&
        h('div', { class: 'home-intro' }, [
          h('h1', {}, 'Центральный слайдофонд'),
        ]),
      spacesRow,
      h('div', { class: 'search-box-wrap' }, [searchForm]),
      h('div', { class: 'storage-link-wrap' }, [
        h('button', { class: 'storage-link', onClick: actions.onOpenStorage, 'data-testid': 'button-open-storage' }, [
          svgIcon('archive'),
          'Хранилище презентаций',
        ]),
      ]),
      h('div', { class: 'results-area', id: 'results-slot' }),
    ]
  );

  mount(container, view);
  return view.querySelector('#results-slot');
}

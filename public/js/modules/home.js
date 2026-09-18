import { h, mount } from './render.js';
import { svgIcon } from './icons.js';

// Рендерит главный экран: строку поиска, переключатель пространств и кнопку хранилища.
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
          class: `space-pill ${space.id === state.activeSpaceId ? 'active' : ''}`,
          onClick: () => actions.onSelectSpace(space.id),
          role: 'tab',
          'aria-selected': space.id === state.activeSpaceId ? 'true' : 'false',
          'data-testid': `space-pill-${space.slug}`,
        },
        [svgIcon(space.icon) || svgIcon('folder'), space.name]
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
      svgIcon('search'),
      h('input', {
        class: 'search-input',
        type: 'text',
        placeholder: 'Найти слайд по теме или описать нужную презентацию…',
        value: state.query || '',
        'data-testid': 'input-search',
      }),
      h('button', { class: 'btn btn-primary', type: 'submit', 'data-testid': 'button-search' }, 'Найти'),
    ]
  );

  const view = h(
    'div',
    { class: `home-view ${isTop ? 'top-aligned' : 'centered'}` },
    [
      !isTop &&
        h('div', { class: 'home-intro' }, [
          h('h1', {}, 'SlideVault'),
          h('p', {}, 'Храните презентации, находите нужные слайды по смыслу и собирайте новые презентации из готовых материалов.'),
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

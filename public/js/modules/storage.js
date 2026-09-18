import { h, mount } from './render.js';
import { svgIcon } from './icons.js';
import { renderFolderTree } from './folderTree.js';
import { renderFileList } from './fileList.js';
import { attachUploadZone, openFilePicker } from './upload.js';

// Рендерит экран хранилища: заголовок, дерево папок слева, список файлов справа.
// Возвращает ссылки на DOM-узлы, которые нужно обновлять отдельно (folderPanelEl, filePanelEl).
export function renderStorageShell(container, { spaces, activeSpaceId, canEdit, fileSortBy = 'date', fileSortOrder = 'desc' }, actions) {
  const header = h('div', { class: 'storage-header' }, [
    h('button', { class: 'back-btn', onClick: actions.onBackHome, 'data-testid': 'button-storage-back' }, [
      svgIcon('back'),
      'На главную',
    ]),
    h(
      'div',
      { class: 'spaces-row', style: 'margin:0;' },
      spaces.map((space) =>
        h(
          'button',
          {
            class: `space-pill ${space.id === activeSpaceId ? 'active' : ''}`,
            onClick: () => actions.onSelectSpace(space.id),
            'data-testid': `storage-space-${space.slug}`,
          },
          [svgIcon(space.icon) || svgIcon('folder'), space.name]
        )
      )
    ),
    canEdit
      ? h('button', { class: 'btn btn-primary btn-sm', onClick: () => actions.onCreateRootFolder(), 'data-testid': 'button-new-root-folder' }, [
          svgIcon('plus'),
          'Новая папка',
        ])
      : h('div'),
  ]);

  const folderPanel = h('div', { class: 'folder-panel' }, [
    h('div', { class: 'folder-panel-header' }, [
      h('h3', {}, 'Папки'),
      canEdit &&
        h('div', { class: 'folder-panel-tools' }, [
          h(
            'button',
            {
              class: 'icon-btn',
              'aria-label': 'Отсортировать корневые папки по алфавиту (А→Я)',
              title: 'Корневые папки: А→Я',
              onClick: () => actions.onSortRootFolders('asc'),
              'data-testid': 'button-sort-root-asc',
            },
            [svgIcon('sortAsc')]
          ),
          h(
            'button',
            {
              class: 'icon-btn',
              'aria-label': 'Отсортировать корневые папки по алфавиту (Я→А)',
              title: 'Корневые папки: Я→А',
              onClick: () => actions.onSortRootFolders('desc'),
              'data-testid': 'button-sort-root-desc',
            },
            [svgIcon('sortDesc')]
          ),
        ]),
    ]),
    h('div', { class: 'folder-tree-slot' }),
  ]);

  const sortSelect = h(
    'select',
    {
      class: 'file-sort-select',
      'aria-label': 'Сортировать файлы по',
      'data-testid': 'select-file-sort',
      onChange: (e) => actions.onChangeFileSort(e.target.value, fileSortOrder),
    },
    [
      h('option', { value: 'date', selected: fileSortBy === 'date' ? 'selected' : undefined }, 'По дате загрузки'),
      h('option', { value: 'name', selected: fileSortBy === 'name' ? 'selected' : undefined }, 'По названию'),
      h('option', { value: 'size', selected: fileSortBy === 'size' ? 'selected' : undefined }, 'По размеру'),
    ]
  );
  sortSelect.value = fileSortBy;

  const sortDirBtn = h(
    'button',
    {
      class: 'icon-btn',
      'aria-label': fileSortOrder === 'asc' ? 'По возрастанию' : 'По убыванию',
      title: fileSortOrder === 'asc' ? 'По возрастанию' : 'По убыванию',
      onClick: () => actions.onChangeFileSort(fileSortBy, fileSortOrder === 'asc' ? 'desc' : 'asc'),
      'data-testid': 'button-file-sort-direction',
    },
    [svgIcon(fileSortOrder === 'asc' ? 'sortAsc' : 'sortDesc')]
  );

  const filePanel = h('div', { class: 'file-panel' }, [
    h('div', { class: 'file-panel-header' }, [
      h('div', {}, [h('h2', { class: 'file-panel-title' }, ''), h('div', { class: 'file-panel-breadcrumb' })]),
      h('div', { class: 'file-panel-sort-controls' }, [sortSelect, sortDirBtn]),
      canEdit &&
        h('button', { class: 'btn btn-primary upload-zone-btn', onClick: () => openFilePicker(actions.onFilesSelected), 'data-testid': 'button-upload' }, [
          svgIcon('upload'),
          'Загрузить презентацию',
        ]),
    ]),
    h('div', { class: 'file-list-slot' }),
  ]);

  const body = h('div', { class: 'storage-body' }, [folderPanel, filePanel]);
  mount(container, h('div', { class: 'storage-view' }, [header, body]));

  if (canEdit) {
    attachUploadZone(filePanel, actions.onFilesSelected);
  }

  return {
    folderTreeSlot: folderPanel.querySelector('.folder-tree-slot'),
    filePanelTitle: filePanel.querySelector('.file-panel-title'),
    filePanelBreadcrumb: filePanel.querySelector('.file-panel-breadcrumb'),
    fileListSlot: filePanel.querySelector('.file-list-slot'),
  };
}

export { renderFolderTree, renderFileList };

import { h, mount } from './render.js';
import { svgIcon } from './icons.js';
import { renderFolderTree } from './folderTree.js';
import { renderFileList } from './fileList.js';
import { attachUploadZone, openFilePicker } from './upload.js';

// Рендерит экран хранилища: заголовок, дерево папок слева, список файлов справа.
// Возвращает ссылки на DOM-узлы, которые нужно обновлять отдельно (folderPanelEl, filePanelEl).
export function renderStorageShell(container, { spaces, activeSpaceId, canEdit }, actions) {
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
    h('div', { class: 'folder-panel-header' }, [h('h3', {}, 'Папки')]),
    h('div', { class: 'folder-tree-slot' }),
  ]);

  const filePanel = h('div', { class: 'file-panel' }, [
    h('div', { class: 'file-panel-header' }, [
      h('div', {}, [h('h2', { class: 'file-panel-title' }, ''), h('div', { class: 'file-panel-breadcrumb' })]),
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

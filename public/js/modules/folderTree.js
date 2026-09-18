import { h } from './render.js';
import { svgIcon } from './icons.js';

// Строит дерево из плоского списка папок {id, parentId, name}
function buildTree(folders) {
  const byParent = new Map();
  folders.forEach((f) => {
    const key = f.parentId || 'root';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(f);
  });
  return byParent;
}

function closeAnyContextMenu() {
  document.querySelectorAll('.context-menu').forEach((m) => m.remove());
}

// Рендерит дерево папок. canEdit — может ли пользователь создавать/переименовывать/удалять папки.
// actions: { onSelect(folderId), onCreate(parentId), onRename(folderId, name), onDelete(folderId) }
export function renderFolderTree(container, { folders, selectedFolderId, expandedIds, canEdit }, actions) {
  const byParent = buildTree(folders);

  function renderNode(folder, depth) {
    const children = byParent.get(folder.id) || [];
    const hasChildren = children.length > 0;
    const isExpanded = expandedIds.has(folder.id);
    const isSelected = folder.id === selectedFolderId;

    const row = h(
      'div',
      {
        class: `folder-row ${isSelected ? 'selected' : ''}`,
        'data-testid': `folder-row-${folder.id}`,
        onClick: () => actions.onSelect(folder.id),
      },
      [
        h('span', {
          class: `chevron ${isExpanded ? 'open' : ''}`,
          html: hasChildren ? svgIconMarkup('chevron') : '',
          onClick: (e) => {
            if (!hasChildren) return;
            e.stopPropagation();
            actions.onToggleExpand(folder.id);
          },
        }),
        svgIcon(isExpanded ? 'folderOpen' : 'folder', 'folder-icon'),
        h('span', { class: 'folder-name' }, folder.name),
        canEdit &&
          h(
            'button',
            {
              class: 'icon-btn folder-menu-btn',
              'aria-label': 'Действия с папкой',
              onClick: (e) => {
                e.stopPropagation();
                openFolderContextMenu(e.currentTarget, folder, actions);
              },
            },
            [svgIcon('more')]
          ),
      ]
    );

    const childrenNode =
      isExpanded && hasChildren
        ? h(
            'div',
            { class: 'folder-children' },
            children
              .slice()
              .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'ru'))
              .map((c) => renderNode(c, depth + 1))
          )
        : null;

    return h('div', { class: 'folder-node' }, [row, childrenNode]);
  }

  const roots = (byParent.get('root') || []).slice().sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'ru'));
  const treeNode = h('div', { class: 'folder-tree' }, roots.map((f) => renderNode(f, 0)));

  container.replaceChildren(treeNode);
}

function svgIconMarkup(name) {
  const el = svgIcon(name);
  return el ? el.outerHTML : '';
}

function openFolderContextMenu(anchorEl, folder, actions) {
  closeAnyContextMenu();
  const rect = anchorEl.getBoundingClientRect();
  const menu = h('div', { class: 'context-menu' }, [
    h(
      'button',
      {
        onClick: () => {
          closeAnyContextMenu();
          actions.onCreate(folder.id);
        },
      },
      [svgIcon('plus'), 'Новая подпапка']
    ),
    h(
      'button',
      {
        onClick: () => {
          closeAnyContextMenu();
          actions.onRename(folder.id, folder.name);
        },
      },
      [svgIcon('edit'), 'Переименовать']
    ),
    h(
      'button',
      {
        onClick: () => {
          closeAnyContextMenu();
          actions.onMoveUp(folder.id);
        },
      },
      [svgIcon('arrowUp'), 'Переместить выше']
    ),
    h(
      'button',
      {
        onClick: () => {
          closeAnyContextMenu();
          actions.onMoveDown(folder.id);
        },
      },
      [svgIcon('arrowDown'), 'Переместить ниже']
    ),
    h(
      'button',
      {
        onClick: () => {
          closeAnyContextMenu();
          actions.onSortChildren(folder.id, 'asc');
        },
      },
      [svgIcon('sortAsc'), 'Содержимое: А→Я']
    ),
    h(
      'button',
      {
        onClick: () => {
          closeAnyContextMenu();
          actions.onSortChildren(folder.id, 'desc');
        },
      },
      [svgIcon('sortDesc'), 'Содержимое: Я→А']
    ),
    h(
      'button',
      {
        class: 'danger',
        onClick: () => {
          closeAnyContextMenu();
          actions.onDelete(folder.id, folder.name);
        },
      },
      [svgIcon('trash'), 'Удалить']
    ),
  ]);
  menu.style.position = 'fixed';
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.left = `${Math.min(rect.left, window.innerWidth - 190)}px`;
  document.body.appendChild(menu);

  setTimeout(() => {
    document.addEventListener('click', function handler(e) {
      if (!menu.contains(e.target)) {
        menu.remove();
        document.removeEventListener('click', handler);
      }
    });
  }, 0);
}

export { closeAnyContextMenu };

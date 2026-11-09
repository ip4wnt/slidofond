import { h, mount } from './modules/render.js';
import { api } from './modules/api.js';
import { createStore } from './state/store.js';
import { renderLogin } from './modules/login.js';
import { renderHome } from './modules/home.js';
import { renderLoading, renderSearchResults, renderBuildResult, isBuildRequest } from './modules/searchResults.js';
import { renderStorageShell, renderFolderTree, renderFileList } from './modules/storage.js';
import { renderGenerateScreen, initGenerateWizard, prefillGenerateMode, prefillGenerateFromSearch } from './modules/generate.js';
import { openGallery } from './modules/slideGallery.js';
import { promptDialog, confirmDialog } from './modules/dialogs.js';
import { openUsersAdminDialog } from './modules/usersAdmin.js';
import { showToast } from './modules/toast.js';
import { svgIcon } from './modules/icons.js';
import { openFilePicker } from './modules/upload.js';

const root = document.getElementById('app');

const store = createStore({
  screen: 'loading', // loading | login | home | storage | generate
  user: null,
  spaces: [],
  activeSpaceId: null, // единственное активное пространство — поиск и архив всегда ведутся в одном пространстве
  homeView: 'idle', // idle | loading | search-results | build-result
  query: '',
  searchIntent: 'slide', // slide | presentation — что именно искал пользователь по последнему запросу
  searchMode: 'slide', // режим, выбранный кнопками под строкой поиска: slide | presentation
  menuOpen: false, // выпадающее меню за бургером в шапке
  searchResults: [],
  presentationResults: [],
  buildResult: null,

  // storage screen
  storageSpaceId: null,
  fileSortBy: 'date',
  fileSortOrder: 'desc',
  folders: [],
  expandedFolderIds: new Set(),
  selectedFolderId: null,
  presentations: [],
  expandedPresentationId: null,
  highlightPresentationId: null, // карточка, к которой перешли из результатов поиска (кратко подсвечивается)
  cutFolderId: null,

  // Активные загрузки в этой папке: [{ localId, fileName, progress, phase, errorMessage }]
  // phase: 'uploading' | 'processing' | 'error'. Успешные завершённые загрузки убираются из списка,
  // когда презентация переходит в summaryStatus 'done' в общем списке presentations.
  uploads: [],
});


// ============ BOOTSTRAP ============
async function bootstrap() {
  try {
    const user = await api.me();
    const spaces = await api.listSpaces();
    const defaultSpace = spaces.find((s) => s.isDefault) || spaces[0];
    store.setState({
      screen: 'home',
      user,
      spaces,
      activeSpaceId: defaultSpace ? defaultSpace.id : null,
    });
  } catch (err) {
    store.setState({ screen: 'login' });
  }
}

// ============ HEADER (общая шапка авторизованных экранов) ============
// По макету: логотип слева, по центру — название текущего раздела («Поиск», «Проводник»…),
// справа — чип пользователя и бургер.
// За бургером — проводник, генерация таблиц/графиков, пользователи (для админа) и выход.
const SCREEN_TITLES = { home: 'Поиск', storage: 'Проводник', generate: 'Таблицы и графики', users: 'Пользователи' };

function renderAppHeader(user, state) {
  const menuItems = [
    { id: 'home', label: 'Поиск', icon: 'search', onClick: () => { closeMenu(); goHome(); }, active: state.screen === 'home' },
    { id: 'storage', label: 'Проводник', icon: 'folderOpen', onClick: () => { closeMenu(); onOpenStorage(); }, active: state.screen === 'storage', testid: 'menu-storage' },
    // Генерация таблиц/графиков по данным (экран generate) скрыта из меню до реализации
    // полноценной генерации презентаций; код модуля сохранен.
    user.role === 'admin' && { id: 'users', label: 'Пользователи', icon: 'users', onClick: () => { closeMenu(); onOpenUsersAdmin(); }, testid: 'menu-users' },
  ].filter(Boolean);

  const burgerWrap = h('div', { class: 'burger-wrap' }, [
    h('button', {
      class: 'burger-btn', 'aria-label': 'Меню', 'aria-expanded': state.menuOpen ? 'true' : 'false', 'aria-haspopup': 'true',
      'data-testid': 'button-menu',
      onClick: (e) => { e.stopPropagation(); store.setState({ menuOpen: !store.getState().menuOpen }); },
    }, [svgIcon('burger')]),
    state.menuOpen && h('nav', { class: 'burger-menu', 'aria-label': 'Разделы', onClick: (e) => e.stopPropagation() }, [
      ...menuItems.map((item) =>
        h('button', { class: item.active ? 'active' : '', onClick: item.onClick, 'data-testid': item.testid || null }, [svgIcon(item.icon), item.label])
      ),
      h('div', { class: 'menu-sep' }),
      h('button', { onClick: () => { closeMenu(); onLogout(); }, 'data-testid': 'menu-logout' }, [svgIcon('logout'), 'Выйти']),
    ]),
  ]);

  const initials = (user.displayName || user.login || '?').split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();

  return h('header', { class: 'app-header' }, [
    h('div', { class: 'brand' }, [
      h('button', { class: 'brand', 'aria-label': 'На главную', onClick: goHome }, [
        h('img', { class: 'brand-mark', src: 'assets/logo/fpg-logo.svg', alt: 'Фонд Президентских грантов' }),
      ]),
    ]),
    h('h1', { class: 'app-title' }, [h('button', { onClick: goHome, 'aria-label': 'К поиску', 'data-testid': 'app-title' }, SCREEN_TITLES[state.screen] || 'Поиск')]),
    h('div', { class: 'header-actions' }, [
      h('div', { class: 'auth-chip', 'data-testid': 'auth-chip' }, [
        h('div', { class: 'auth-chip-avatar', 'aria-hidden': 'true' }, initials),
        h('div', { class: 'auth-chip-text' }, [
          h('span', { class: 'auth-chip-name' }, user.displayName),
          h('span', { class: 'auth-chip-role' }, ROLE_LABELS_RU[user.role]),
        ]),
        h('button', { class: 'auth-chip-logout', 'aria-label': 'Выйти', title: 'Выйти', onClick: onLogout, 'data-testid': 'button-logout' }, [svgIcon('logout')]),
      ]),
      burgerWrap,
    ]),
  ]);
}

function closeMenu() {
  if (store.getState().menuOpen) store.setState({ menuOpen: false });
}
document.addEventListener('click', closeMenu);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

function goHome() {
  const { screen } = store.getState();
  if (screen === 'home') store.setState({ homeView: 'idle', query: '', searchResults: [], presentationResults: [], buildResult: null });
  else store.setState({ screen: 'home' });
}

// Декор страницы из макета: теплое свечение сверху и два контурных параллелограмма.
function renderPageDecor() {
  return [
    h('div', { class: 'page-glow', 'aria-hidden': 'true' }),
    h('img', { class: 'page-deco page-deco-large', src: 'assets/deco-large.svg', alt: '', 'aria-hidden': 'true' }),
    h('img', { class: 'page-deco page-deco-small', src: 'assets/deco-small.svg', alt: '', 'aria-hidden': 'true' }),
  ];
}

function renderShell(state) {
  root.classList.remove('is-login');
  root.classList.toggle('is-home', state.screen === 'home');
  const shell = h('div', { class: 'shell' }, [...renderPageDecor(), renderAppHeader(state.user, state)]);
  mount(root, shell);
  const bodyContainer = h('div', { class: 'view' });
  shell.appendChild(bodyContainer);
  return bodyContainer;
}

const ROLE_LABELS_RU = { reader: 'Читатель', editor: 'Редактор', admin: 'Администратор' };

// ============ LOGIN ============
async function onLoginSubmit(login, password) {
  store.setState({ loginPending: true, loginError: null });
  try {
    const user = await api.login(login, password);
    const spaces = await api.listSpaces();
    const defaultSpace = spaces.find((s) => s.isDefault) || spaces[0];
    store.setState({
      screen: 'home',
      user,
      spaces,
      activeSpaceId: defaultSpace ? defaultSpace.id : null,
      loginPending: false,
      loginError: null,
    });
  } catch (err) {
    store.setState({ loginPending: false, loginError: err.message });
  }
}

async function onLogout() {
  await api.logout();
  store.setState({ screen: 'login', user: null, homeView: 'idle', query: '' });
}

// ============ HOME / SEARCH ============
// Пространства теперь работают как переключатель вкладок (одно активное пространство), а не
// как множественный фильтр: поиск и архив ведутся только в одном конкретном пространстве.
function onSelectSpace(spaceId) {
  store.setState({ activeSpaceId: spaceId, homeView: 'idle', query: '', searchResults: [], presentationResults: [], buildResult: null });
}

// Режим под строкой поиска. Если результаты уже показаны — переискиваем тем же запросом.
function onSetSearchMode(mode) {
  const { searchMode, query, homeView } = store.getState();
  if (mode === searchMode) return;
  store.setState({ searchMode: mode });
  if (homeView === 'search-results' && query) onSubmitSearch(query);
}

async function onSubmitSearch(query) {
  if (!query) return;
  store.setState({ query, homeView: 'loading' });

  const { activeSpaceId, searchMode } = store.getState();

  if (isBuildRequest(query)) {
    try {
      const searchData = await api.search(query, activeSpaceId);
      const slides = searchData.slides;
      if (slides.length === 0) {
        showToast('Не найдено слайдов по вашему запросу', 'error');
        store.setState({ homeView: 'search-results', searchResults: [], presentationResults: [], searchIntent: 'slide' });
        return;
      }
      const built = await api.buildPresentation(
        slides.map((s) => s.slideId),
        query
      );
      store.setState({
        homeView: 'build-result',
        buildResult: {
          query,
          downloadUrl: api.buildDownloadUrl(built.id),
          slideCount: built.slideCount,
          expiresAt: built.expiresAt,
        },
      });
    } catch (err) {
      showToast(err.message, 'error');
      store.setState({ homeView: 'idle' });
    }
  } else {
    try {
      const data = await api.search(query, activeSpaceId, searchMode);
      if (data.intent === 'generate_table' || data.intent === 'generate_chart') {
        // Block 3: строка поиска только распознаёт намерение и подбирает образец стиля из
        // пространства — саму генерацию (нужен файл Excel с данными) продолжаем на отдельном
        // экране-мастере, предзаполненном найденным styleReference, если он есть.
        store.setState({ homeView: 'idle', query: '' });
        initGenerateWizard();
        if (data.styleReference) {
          prefillGenerateFromSearch(data.intent === 'generate_table' ? 'table' : 'chart', data.styleReference);
        } else {
          prefillGenerateMode(data.intent === 'generate_table' ? 'table' : 'chart');
          showToast('В пространстве пока нет образцов такого стиля — приложите свой файл-образец на шаге 3', 'default');
        }
        store.setState({ screen: 'generate' });
        return;
      }
      store.setState({
        homeView: 'search-results',
        searchResults: data.slides || [],
        presentationResults: data.presentations || [],
        searchIntent: data.intent || 'slide',
        searchContext: { topicWords: data.topicWords || [], contextWords: data.contextWords || [] },
      });
    } catch (err) {
      showToast(err.message, 'error');
      store.setState({ homeView: 'idle' });
    }
  }
}

function onBackHome() {
  store.setState({ homeView: 'idle', query: '', searchResults: [], presentationResults: [], buildResult: null });
}

function onOpenStorage() {
  const { activeSpaceId, spaces } = store.getState();
  const spaceId = activeSpaceId || (spaces[0] && spaces[0].id);
  store.setState({ screen: 'storage' });
  loadStorageSpace(spaceId);
}

function onOpenGenerate() {
  initGenerateWizard();
  store.setState({ screen: 'generate' });
}

function onGenerateBackHome() {
  store.setState({ screen: 'home' });
}

function onStorageBackHome() {
  store.setState({ screen: 'home' });
}

async function onPreviewSlide(slide) {
  openGallery([{ previewUrl: slide.previewUrl, title: slide.title, description: slide.description }], 0);
}

// Открывает галерею для карточки-презентации из результатов поиска (там поле называется presentationId, а не id).
async function onOpenPresentationFromSearch(presentation) {
  await onOpenGalleryForPresentation({ id: presentation.presentationId });
}

// Скачивает всю найденную презентацию целиком (исходный файл, как и в архиве).
function onDownloadPresentationFromSearch(presentation) {
  window.open(api.downloadPresentationUrl(presentation.presentationId), '_blank');
}

// Открывает презентацию найденного слайда в проводнике: нужное пространство, папка, карточка
// раскрыта на метаданных и подсвечена — оттуда можно скачать файл целиком и посмотреть, где он использовался.
async function onOpenInExplorer(slide) {
  const { folders: currentFolders, storageSpaceId } = store.getState();
  try {
    const folders = storageSpaceId === slide.spaceId && currentFolders.length ? currentFolders : await api.listFolders(slide.spaceId);
    // раскрываем всех предков папки, чтобы она была видна в дереве
    const byId = new Map(folders.map((f) => [f.id, f]));
    const expanded = new Set(store.getState().storageSpaceId === slide.spaceId ? store.getState().expandedFolderIds : []);
    let cur = byId.get(slide.folderId);
    while (cur) {
      expanded.add(cur.id);
      cur = cur.parentId ? byId.get(cur.parentId) : null;
    }
    const { fileSortBy, fileSortOrder } = store.getState();
    const presentations = await api.listPresentations(slide.folderId, fileSortBy, fileSortOrder);
    store.setState({
      screen: 'storage',
      storageSpaceId: slide.spaceId,
      folders,
      expandedFolderIds: expanded,
      selectedFolderId: slide.folderId,
      presentations,
      expandedPresentationId: slide.presentationId,
      highlightPresentationId: slide.presentationId,
    });
    requestAnimationFrame(() => {
      const card = document.querySelector(`[data-testid="file-card-${slide.presentationId}"]`);
      if (card) card.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
    setTimeout(() => {
      if (store.getState().highlightPresentationId === slide.presentationId) store.setState({ highlightPresentationId: null });
    }, 2500);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function onCopySlide(slide) {
  try {
    const built = await api.buildPresentation([slide.slideId], `Слайд: ${slide.title || ''}`);
    const base = (slide.originalFilename || 'presentation').replace(/\.pptx?$/i, '');
    const name = `${base} - слайд ${(slide.index ?? 0) + 1}`;
    // Скачиваем через blob, чтобы имя файла задавалось на клиенте и не зависело от разбора заголовков браузером
    const response = await fetch(api.buildDownloadUrl(built.id, name), { credentials: 'same-origin' });
    if (!response.ok) throw new Error('Не удалось скачать подготовленный файл');
    const blobUrl = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = `${name}.pptx`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    showToast('Слайд скачивается отдельным файлом .pptx', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ============ STORAGE ============
function firstRootFolder(folders) {
  return folders
    .filter((f) => f.parentId === null)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'ru'))[0];
}

async function loadStorageSpace(spaceId) {
  try {
    const folders = await api.listFolders(spaceId);
    const rootFolder = firstRootFolder(folders);
    store.setState({
      storageSpaceId: spaceId,
      folders,
      expandedFolderIds: new Set(rootFolder ? [rootFolder.id] : []),
      selectedFolderId: rootFolder ? rootFolder.id : null,
      presentations: [],
      expandedPresentationId: null,
    });
    if (rootFolder) await loadPresentations(rootFolder.id);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function loadPresentations(folderId) {
  try {
    const { fileSortBy, fileSortOrder } = store.getState();
    const presentations = await api.listPresentations(folderId, fileSortBy, fileSortOrder);
    store.setState({ presentations, selectedFolderId: folderId, expandedPresentationId: null });
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// Смена порядка сортировки файлов в текущей папке — перезагружаем список с новыми параметрами.
async function onChangeFileSort(sortBy, sortOrder) {
  store.setState({ fileSortBy: sortBy, fileSortOrder: sortOrder });
  const { selectedFolderId } = store.getState();
  if (selectedFolderId) await loadPresentations(selectedFolderId);
}

function onSelectFolder(folderId) {
  // При переходе в другую папку карточки активных загрузок из прежней папки больше не относятся сюда.
  store.setState({ uploads: [] });
  loadPresentations(folderId);
}

function onToggleExpandFolder(folderId) {
  const { expandedFolderIds } = store.getState();
  const next = new Set(expandedFolderIds);
  if (next.has(folderId)) next.delete(folderId);
  else next.add(folderId);
  store.setState({ expandedFolderIds: next });
}

async function onCreateFolder(parentId) {
  const name = await promptDialog({ title: 'Новая папка', label: 'Название папки', confirmLabel: 'Создать' });
  if (!name) return;
  const { storageSpaceId } = store.getState();
  try {
    await api.createFolder({ spaceId: storageSpaceId, parentId, name });
    const folders = await api.listFolders(storageSpaceId);
    const expanded = new Set(store.getState().expandedFolderIds);
    if (parentId) expanded.add(parentId);
    store.setState({ folders, expandedFolderIds: expanded });
    showToast('Папка создана', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function onRenameFolder(folderId, currentName) {
  const name = await promptDialog({ title: 'Переименовать папку', label: 'Новое название', initialValue: currentName, confirmLabel: 'Сохранить' });
  if (!name || name === currentName) return;
  try {
    await api.updateFolder(folderId, { name });
    const folders = await api.listFolders(store.getState().storageSpaceId);
    store.setState({ folders });
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function onDeleteFolder(folderId, name) {
  const confirmed = await confirmDialog({
    title: 'Удалить папку?',
    message: `Папка «${name}» и все презентации внутри неё (включая вложенные подпапки) будут удалены безвозвратно.`,
  });
  if (!confirmed) return;
  try {
    await api.deleteFolder(folderId);
    const { storageSpaceId } = store.getState();
    const folders = await api.listFolders(storageSpaceId);
    const rootFolder = firstRootFolder(folders);
    store.setState({ folders, selectedFolderId: rootFolder ? rootFolder.id : null });
    if (rootFolder) loadPresentations(rootFolder.id);
    showToast('Папка удалена', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function onCreateRootFolder() {
  await onCreateFolder(null);
}

// ============ ТУЛБАР АРХИВА: действия над выбранной папкой (логика как в проводнике) ============

function currentSelectedFolder() {
  const { folders, selectedFolderId } = store.getState();
  return folders.find((f) => f.id === selectedFolderId) || null;
}

async function onRenameSelectedFolder() {
  const folder = currentSelectedFolder();
  if (!folder) return;
  await onRenameFolder(folder.id, folder.name);
}

async function onDeleteSelected() {
  const folder = currentSelectedFolder();
  if (!folder) return;
  await onDeleteFolder(folder.id, folder.name);
}

async function onCutSelected() {
  const folder = currentSelectedFolder();
  if (!folder) return;
  const { cutFolderId, folders, storageSpaceId } = store.getState();

  // Первый клик без активного вырезания — помечаем текущую папку как источник.
  if (!cutFolderId) {
    store.setState({ cutFolderId: folder.id });
    showToast(`Папка «${folder.name}» вырезана. Выберите целевую папку и нажмите «Вырезать» ещё раз, чтобы переместить сюда.`, 'success');
    return;
  }

  // Повторный клик на той же папке — отмена вырезания.
  if (cutFolderId === folder.id) {
    store.setState({ cutFolderId: null });
    showToast('Вырезание отменено', 'success');
    return;
  }

  // Защита от переноса в свою же подпапку (цикл) — проверяем цепочку родителей цели.
  let cursor = folder.id;
  while (cursor) {
    if (cursor === cutFolderId) {
      showToast('Нельзя переместить папку в свою же подпапку', 'error');
      return;
    }
    const cursorFolder = folders.find((f) => f.id === cursor);
    cursor = cursorFolder ? cursorFolder.parentId : null;
  }

  const movedFolder = folders.find((f) => f.id === cutFolderId);
  try {
    await api.updateFolder(cutFolderId, { parentId: folder.id });
    const updatedFolders = await api.listFolders(storageSpaceId);
    const expanded = new Set(store.getState().expandedFolderIds);
    expanded.add(folder.id);
    store.setState({ folders: updatedFolders, cutFolderId: null, expandedFolderIds: expanded });
    showToast(`Папка «${movedFolder ? movedFolder.name : ''}» перемещена в «${folder.name}»`, 'success');
  } catch (err) {
    store.setState({ cutFolderId: null });
    showToast(err.message, 'error');
  }
}

async function onDownloadSelected() {
  const folder = currentSelectedFolder();
  if (!folder) return;
  const { presentations } = store.getState();
  if (presentations.length === 0) {
    showToast('В этой папке нет презентаций для скачивания', 'error');
    return;
  }
  presentations.forEach((p) => window.open(api.downloadPresentationUrl(p.id), '_blank'));
}

// Переместить папку на одну позицию вверх/вниз среди сиблингов.
async function onMoveFolder(folderId, direction) {
  try {
    await api.reorderFolder(folderId, direction);
    const folders = await api.listFolders(store.getState().storageSpaceId);
    store.setState({ folders });
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function onMoveFolderUp(folderId) {
  return onMoveFolder(folderId, 'up');
}

function onMoveFolderDown(folderId) {
  return onMoveFolder(folderId, 'down');
}

// Отсортировать все подпапки внутри заданной папки по алфавиту (asc/desc).
async function onSortFolderChildren(parentId, order) {
  try {
    const { storageSpaceId } = store.getState();
    await api.sortFolders(storageSpaceId, parentId, order);
    const folders = await api.listFolders(storageSpaceId);
    store.setState({ folders });
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// Отсортировать корневые папки пространства (без родителя) по алфавиту.
async function onSortRootFolders(order) {
  await onSortFolderChildren(null, order);
}

function onSelectStorageSpace(spaceId) {
  loadStorageSpace(spaceId);
}

let uploadCounter = 0;

function patchUpload(localId, patch) {
  const { uploads } = store.getState();
  store.setState({ uploads: uploads.map((u) => (u.localId === localId ? { ...u, ...patch } : u)) });
}

function removeUpload(localId) {
  const { uploads } = store.getState();
  store.setState({ uploads: uploads.filter((u) => u.localId !== localId) });
}

// Файлы, брошенные на папку в дереве: папка становится текущей, затем обычная загрузка.
async function onDropFilesToFolder(folderId, fileList) {
  if (store.getState().selectedFolderId !== folderId) {
    onSelectFolder(folderId);
    await loadPresentations(folderId);
  }
  return onFilesSelected(fileList);
}

// Перенос презентации в другую папку перетаскиванием карточки на папку дерева.
async function onMovePresentationToFolder(presentationId, folderId) {
  const { selectedFolderId, presentations } = store.getState();
  if (!folderId || folderId === selectedFolderId) return;
  const p = presentations.find((x) => x.id === presentationId);
  try {
    await api.movePresentation(presentationId, folderId);
    const target = store.getState().folders.find((f) => f.id === folderId);
    showToast(`«${p ? p.originalFilename : 'Презентация'}» перенесена в папку «${target ? target.name : ''}»`);
    await loadPresentations(selectedFolderId);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// Блок «Где использовалась» — сохраняется целиком, сервер вернет обновленную карточку.
async function onSaveUsage(id, usage) {
  const updated = await api.updateUsage(id, usage);
  const { presentations } = store.getState();
  store.setState({ presentations: presentations.map((p) => (p.id === id ? { ...p, usage: updated.usage } : p)) });
  showToast('Сведения об использовании сохранены');
}

async function onFilesSelected(fileList) {
  const { selectedFolderId, storageSpaceId } = store.getState();
  if (!selectedFolderId) {
    showToast('Сначала выберите папку для загрузки', 'error');
    return;
  }

  const files = Array.from(fileList);
  // Заводим видимые карточки загрузки сразу для всех файлов, чтобы пользователь сразу видел прогресс,
  // а не тишину до момента ответа сервера.
  const entries = files.map((file) => ({
    localId: `upload-${++uploadCounter}`,
    file,
    fileName: file.name,
    progress: 0,
    phase: 'uploading', // uploading | processing | error
    errorMessage: null,
  }));
  store.setState({ uploads: [...store.getState().uploads, ...entries.map(({ file, ...rest }) => rest)] });

  // Файлы загружаются последовательно (проще для бэкенда и понятнее по прогрессу),
  // но каждый файл сразу показывает свой собственный прогресс.
  for (const entry of entries) {
    const formData = new FormData();
    formData.append('file', entry.file);
    formData.append('folderId', selectedFolderId);
    formData.append('spaceId', storageSpaceId);
    try {
      await api.uploadPresentationWithProgress(formData, (fraction) => {
        patchUpload(entry.localId, { progress: fraction });
      });
      // Загрузка байтов завершена — теперь сервер анализирует файл. Карточка остаётся
      // в состоянии «processing» до тех пор, пока опрос не подтвердит статус done/error.
      patchUpload(entry.localId, { phase: 'processing', progress: 1 });
    } catch (err) {
      patchUpload(entry.localId, { phase: 'error', errorMessage: err.message });
      showToast(`Не удалось загрузить «${entry.fileName}»: ${err.message}`, 'error');
    }
  }

  await loadPresentations(selectedFolderId);
  reconcileUploadsWithPresentations();
  pollProcessingPresentations();
}

// Периодически обновляет список, пока есть презентации в статусе processing/pending или активные карточки загрузки.
// Когда презентация из uploads появляется в общем списке с итоговым статусом — убираем её карточку прогресса,
// чтобы она не дублировала карточку в общем списке презентаций.
let pollTimer = null;
function pollProcessingPresentations() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    const { presentations, selectedFolderId, screen, uploads } = store.getState();
    const stillProcessing = presentations.some((p) => p.summaryStatus === 'processing' || p.summaryStatus === 'pending');
    const stillUploading = uploads.some((u) => u.phase === 'processing');
    if ((!stillProcessing && !stillUploading) || screen !== 'storage') {
      clearInterval(pollTimer);
      pollTimer = null;
      return;
    }
    await loadPresentations(selectedFolderId);
    reconcileUploadsWithPresentations();
  }, 3000);
}

// Убирает из uploads те загрузки, чьи файлы уже появились в общем списке с финальным статусом (done/error).
// Сопоставляем по имени файла, т.к. локальная карточка не знает presentationId до завершения анализа.
function reconcileUploadsWithPresentations() {
  const { presentations, uploads } = store.getState();
  if (uploads.length === 0) return;
  const stillPending = uploads.filter((u) => {
    if (u.phase !== 'processing') return true;
    const match = presentations.find(
      (p) => p.originalFilename === u.fileName && (p.summaryStatus === 'done' || p.summaryStatus === 'error')
    );
    return !match;
  });
  if (stillPending.length !== uploads.length) {
    store.setState({ uploads: stillPending });
  }
}

function onToggleExpandPresentation(id) {
  const { expandedPresentationId } = store.getState();
  store.setState({ expandedPresentationId: expandedPresentationId === id ? null : id });
}

async function onSaveSummary(id, summaryText) {
  try {
    await api.updateSummary(id, summaryText);
    const { presentations } = store.getState();
    store.setState({ presentations: presentations.map((p) => (p.id === id ? { ...p, summaryText } : p)) });
    showToast('Описание сохранено', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function onSaveSlideDescription(slideId, description, presentationId) {
  try {
    await api.updateSlide(slideId, { description });
    const { presentations } = store.getState();
    store.setState({
      presentations: presentations.map((p) =>
        p.id === presentationId
          ? { ...p, slides: (p.slides || []).map((s) => (s.id === slideId ? { ...s, description, descriptionEdited: true } : s)) }
          : p
      ),
    });
    showToast('Описание слайда сохранено', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function onDeletePresentation(p) {
  const confirmed = await confirmDialog({ title: 'Удалить презентацию?', message: `Файл «${p.originalFilename}» будет удалён безвозвратно.` });
  if (!confirmed) return;
  try {
    await api.deletePresentation(p.id);
    const { selectedFolderId } = store.getState();
    await loadPresentations(selectedFolderId);
    showToast('Презентация удалена', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function onOpenGalleryForPresentation(p, startIndex = 0) {
  try {
    const full = p.slides ? p : await api.getPresentation(p.id);
    if (!full.slides || full.slides.length === 0) {
      showToast('Превью слайдов ещё не готовы', 'error');
      return;
    }
    openGallery(
      full.slides.map((s) => ({ previewUrl: s.previewUrl, title: s.title, description: s.description })),
      startIndex
    );
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// Загружает полные детали (со слайдами) при разворачивании карточки, если их ещё нет
async function ensurePresentationDetails(id) {
  const { presentations } = store.getState();
  const target = presentations.find((p) => p.id === id);
  if (target && target.slides) return;
  try {
    const full = await api.getPresentation(id);
    store.setState({
      presentations: store.getState().presentations.map((p) => (p.id === id ? full : p)),
    });
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ============ USERS ADMIN ============
async function onOpenUsersAdmin() {
  try {
    const users = await api.listUsers();
    openUsersAdminDialog(users, {
      onCreate: async (data) => {
        try {
          return await api.createUser(data);
        } catch (err) {
          showToast(err.message, 'error');
          return null;
        }
      },
      onUpdateRole: async (id, role) => {
        try {
          await api.updateUser(id, { role });
          showToast('Роль обновлена', 'success');
        } catch (err) {
          showToast(err.message, 'error');
        }
      },
      onRebuildMetadata: async () => {
        try {
          const result = await api.rebuildMetadata();
          showToast('Метаданные пересчитаны', 'success');
          // если открыт проводник — обновим карточки, чтобы увидеть новые значения «Когда»
          const { selectedFolderId, screen } = store.getState();
          if (screen === 'storage' && selectedFolderId) await loadPresentations(selectedFolderId);
          return result;
        } catch (err) {
          showToast(err.message, 'error');
          return null;
        }
      },
      onDelete: async (id, login) => {
        const confirmed = await confirmDialog({ title: 'Удалить пользователя?', message: `Пользователь «${login}» будет удалён.` });
        if (!confirmed) return false;
        try {
          await api.deleteUser(id);
          showToast('Пользователь удалён', 'success');
          return true;
        } catch (err) {
          showToast(err.message, 'error');
          return false;
        }
      },
    });
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ============ RENDER LOOP ============
function render() {
  const state = store.getState();

  if (state.screen === 'loading') {
    mount(root, h('div', { class: 'loading-row' }, [h('div', { class: 'spinner' })]));
    return;
  }

  if (state.screen === 'login') {
    root.classList.add('is-login');
    mount(root, h('div', { class: 'shell' }, [
      ...renderPageDecor(),
      h('header', { class: 'app-header' }, [
        h('img', { class: 'brand-mark', src: 'assets/logo/fpg-logo.svg', alt: 'Фонд Президентских грантов' }),
      ]),
      renderLoginSlot(state),
    ]));
    return;
  }

  if (state.screen === 'home') {
    const bodyContainer = renderShell(state);

    const resultsSlot = renderHome(
      bodyContainer,
      { spaces: state.spaces, activeSpaceId: state.activeSpaceId, view: state.homeView, query: state.query, searchMode: state.searchMode },
      { onSelectSpace, onSubmitSearch, onSetSearchMode }
    );

    if (state.homeView === 'loading') {
      renderLoading(resultsSlot);
    } else if (state.homeView === 'search-results') {
      renderSearchResults(
        resultsSlot,
        { query: state.query, intent: state.searchIntent, slides: state.searchResults, presentations: state.presentationResults, context: state.searchContext },
        { onBackHome, onPreviewSlide, onCopySlide, onOpenInExplorer, onOpenPresentation: onOpenPresentationFromSearch, onDownloadPresentation: onDownloadPresentationFromSearch }
      );
    } else if (state.homeView === 'build-result') {
      renderBuildResult(resultsSlot, state.buildResult, { onBackHome });
    }
    return;
  }

  if (state.screen === 'generate') {
    const bodyContainer = renderShell(state);

    const generateActions = {
      api,
      onBackHome: onGenerateBackHome,
      getSpaceId: () => store.getState().activeSpaceId,
      onRerenderScreen: () => renderGenerateScreen(bodyContainer, generateActions),
    };
    renderGenerateScreen(bodyContainer, generateActions);
    return;
  }

  if (state.screen === 'storage') {
    const bodyContainer = renderShell(state);

    const canEdit = state.user.role === 'editor' || state.user.role === 'admin';
    const slots = renderStorageShell(
      bodyContainer,
      { spaces: state.spaces, activeSpaceId: state.storageSpaceId, canEdit, fileSortBy: state.fileSortBy, fileSortOrder: state.fileSortOrder },
      {
        onBackHome: onStorageBackHome,
        onSelectSpace: onSelectStorageSpace,
        onCreateRootFolder,
        onFilesSelected,
        onSortRootFolders,
        onChangeFileSort,
        onRenameSelectedFolder,
        onCutSelected,
        onDownloadSelected,
        onDeleteSelected,
      }
    );

    renderFolderTree(
      slots.folderTreeSlot,
      { folders: state.folders, selectedFolderId: state.selectedFolderId, expandedIds: state.expandedFolderIds, canEdit, cutFolderId: state.cutFolderId },
      {
        onSelect: onSelectFolder,
        onToggleExpand: onToggleExpandFolder,
        onCreate: onCreateFolder,
        onRename: onRenameFolder,
        onDelete: onDeleteFolder,
        onMoveUp: onMoveFolderUp,
        onMoveDown: onMoveFolderDown,
        onSortChildren: onSortFolderChildren,
        onDropFiles: onDropFilesToFolder,
        onDropPresentation: onMovePresentationToFolder,
      }
    );

    const currentFolder = state.folders.find((f) => f.id === state.selectedFolderId);
    slots.filePanelTitle.textContent = currentFolder ? currentFolder.name : 'Выберите папку';
    slots.filePanelBreadcrumb.textContent = `Презентаций: ${state.presentations.length}`;

    if (state.expandedPresentationId) {
      ensurePresentationDetails(state.expandedPresentationId);
    }

    renderFileList(
      slots.fileListSlot,
      { presentations: state.presentations, uploads: state.uploads, expandedId: state.expandedPresentationId, highlightId: state.highlightPresentationId, currentUser: state.user, canEdit },
      {
        onToggleExpand: onToggleExpandPresentation,
        onDownload: (id) => window.open(api.downloadPresentationUrl(id), '_blank'),
        downloadUrl: (id) => api.downloadPresentationUrl(id),
        onDelete: onDeletePresentation,
        onOpenGallery: onOpenGalleryForPresentation,
        onSaveSummary,
        onSaveSlideDescription,
        onSaveUsage,
        onUploadClick: () => openFilePicker(onFilesSelected),
        onDismissUpload: removeUpload,
      }
    );
    return;
  }
}

function renderLoginSlot(state) {
  const container = h('div');
  renderLogin(container, { error: state.loginError, pending: state.loginPending }, { onSubmit: onLoginSubmit });
  return container;
}

store.subscribe(render);
render();
bootstrap();

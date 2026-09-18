import { h, mount } from './modules/render.js';
import { api } from './modules/api.js';
import { createStore } from './state/store.js';
import { renderLogin } from './modules/login.js';
import { renderHome } from './modules/home.js';
import { renderLoading, renderSearchResults, renderBuildResult, isBuildRequest } from './modules/searchResults.js';
import { renderStorageShell, renderFolderTree, renderFileList } from './modules/storage.js';
import { openGallery } from './modules/slideGallery.js';
import { promptDialog, confirmDialog } from './modules/dialogs.js';
import { openUsersAdminDialog } from './modules/usersAdmin.js';
import { showToast } from './modules/toast.js';
import { svgIcon } from './modules/icons.js';
import { openFilePicker } from './modules/upload.js';

const root = document.getElementById('app');

const store = createStore({
  screen: 'loading', // loading | login | home | storage
  user: null,
  spaces: [],
  activeSpaceId: null, // единственное активное пространство — поиск и архив всегда ведутся в одном пространстве
  homeView: 'idle', // idle | loading | search-results | build-result
  query: '',
  searchIntent: 'slide', // slide | presentation — что именно искал пользователь по последнему запросу
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
  cutFolderId: null,
});

// ============ THEME (system preference, no persistence needed) ============
document.documentElement.setAttribute(
  'data-theme',
  window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
);

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

// ============ HEADER (shared shell for home/storage authenticated screens) ============
function renderAppHeader(user) {
  const header = h('header', { class: 'app-header' }, [
    h('div', { class: 'brand' }, [
      h('img', { class: 'brand-mark', src: 'assets/logo/fpg-logo.svg', alt: 'Фонд Президентских грантов' }),
    ]),
    h('div', { class: 'header-actions' }, [
      user.role === 'admin' &&
        h('button', { class: 'icon-btn', 'aria-label': 'Управление пользователями', onClick: onOpenUsersAdmin, 'data-testid': 'button-users-admin' }, [
          svgIcon('users'),
        ]),
      h('div', { class: 'auth-chip' }, [
        h('div', { class: 'auth-chip-avatar' }, [svgIcon('users')]),
        h('div', { class: 'auth-chip-text' }, [
          h('span', { class: 'auth-chip-name' }, user.displayName),
          h('span', { class: 'auth-chip-role' }, ROLE_LABELS_RU[user.role]),
        ]),
        h('button', { class: 'auth-chip-logout', 'aria-label': 'Выйти', onClick: onLogout, 'data-testid': 'button-logout' }, [svgIcon('logout')]),
      ]),
    ]),
  ]);
  return header;
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

async function onSubmitSearch(query) {
  if (!query) return;
  store.setState({ query, homeView: 'loading' });

  const { activeSpaceId } = store.getState();

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
      const data = await api.search(query, activeSpaceId);
      store.setState({
        homeView: 'search-results',
        searchResults: data.slides || [],
        presentationResults: data.presentations || [],
        searchIntent: data.intent || 'slide',
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

async function onCopySlide(slide) {
  try {
    const built = await api.buildPresentation([slide.slideId], `Копия слайда: ${slide.title || ''}`);
    const link = document.createElement('a');
    link.href = api.buildDownloadUrl(built.id);
    link.download = `${(slide.title || 'slide').slice(0, 40)}.pptx`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    showToast('Слайд подготовлен — скачайте файл и вставьте его в PowerPoint через «Вставить слайды из файла»', 'success');
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

async function onFilesSelected(fileList) {
  const { selectedFolderId, storageSpaceId } = store.getState();
  if (!selectedFolderId) {
    showToast('Сначала выберите папку для загрузки', 'error');
    return;
  }
  for (const file of Array.from(fileList)) {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('folderId', selectedFolderId);
    formData.append('spaceId', storageSpaceId);
    try {
      await api.uploadPresentation(formData);
      showToast(`Файл «${file.name}» загружен, идёт анализ содержимого…`, 'success');
    } catch (err) {
      showToast(`Не удалось загрузить «${file.name}»: ${err.message}`, 'error');
    }
  }
  await loadPresentations(selectedFolderId);
  pollProcessingPresentations();
}

// Периодически обновляет список, пока есть презентации в статусе processing/pending
let pollTimer = null;
function pollProcessingPresentations() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    const { presentations, selectedFolderId, screen } = store.getState();
    const stillProcessing = presentations.some((p) => p.summaryStatus === 'processing' || p.summaryStatus === 'pending');
    if (!stillProcessing || screen !== 'storage') {
      clearInterval(pollTimer);
      pollTimer = null;
      return;
    }
    await loadPresentations(selectedFolderId);
  }, 3000);
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
    mount(root, h('div', {}, [renderLoginSlot(state)]));
    return;
  }

  if (state.screen === 'home') {
    const shell = h('div', {}, [renderAppHeader(state.user)]);
    mount(root, shell);
    const bodyContainer = h('div', { class: 'view' });
    shell.appendChild(bodyContainer);

    const resultsSlot = renderHome(
      bodyContainer,
      { spaces: state.spaces, activeSpaceId: state.activeSpaceId, view: state.homeView, query: state.query },
      { onSelectSpace, onSubmitSearch, onOpenStorage }
    );

    if (state.homeView === 'loading') {
      renderLoading(resultsSlot);
    } else if (state.homeView === 'search-results') {
      renderSearchResults(
        resultsSlot,
        { query: state.query, intent: state.searchIntent, slides: state.searchResults, presentations: state.presentationResults },
        { onBackHome, onPreviewSlide, onCopySlide, onOpenPresentation: onOpenPresentationFromSearch, onDownloadPresentation: onDownloadPresentationFromSearch }
      );
    } else if (state.homeView === 'build-result') {
      renderBuildResult(resultsSlot, state.buildResult, { onBackHome });
    }
    return;
  }

  if (state.screen === 'storage') {
    const shell = h('div', {}, [renderAppHeader(state.user)]);
    mount(root, shell);
    const bodyContainer = h('div', { class: 'view' });
    shell.appendChild(bodyContainer);

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
      { presentations: state.presentations, expandedId: state.expandedPresentationId, currentUser: state.user, canEdit },
      {
        onToggleExpand: onToggleExpandPresentation,
        onDownload: (id) => window.open(api.downloadPresentationUrl(id), '_blank'),
        downloadUrl: (id) => api.downloadPresentationUrl(id),
        onDelete: onDeletePresentation,
        onOpenGallery: onOpenGalleryForPresentation,
        onSaveSummary,
        onSaveSlideDescription,
        onUploadClick: () => openFilePicker(onFilesSelected),
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

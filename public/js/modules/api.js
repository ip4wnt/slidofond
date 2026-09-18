// Обёртка над fetch к /api/*.
// На реальном сервере (nginx + Node на одном хосте) используем пустой базовый путь —
// запросы идут относительно текущего адреса страницы (/api/...), это работает и на
// голом Node (localhost:8000), и за nginx на 80/443 порту.
// Значение можно переопределить глобальной переменной window.SLIDEVAULT_API_BASE,
// если бэкенд когда-нибудь будет вынесен на отдельный домен/порт.
const API_BASE = (typeof window !== 'undefined' && window.SLIDEVAULT_API_BASE) || '';

function apiBase() {
  return API_BASE;
}

async function request(method, url, body, opts = {}) {
  const options = {
    method,
    credentials: 'include',
    headers: {},
  };
  if (body instanceof FormData) {
    options.body = body;
  } else if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const res = await fetch(apiBase() + url, options);
  let data = null;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const message = (data && data.error) || `Ошибка запроса (${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  // auth
  login: (login, password) => request('POST', '/api/auth/login', { login, password }),
  logout: () => request('POST', '/api/auth/logout'),
  me: () => request('GET', '/api/auth/me'),

  // users (admin)
  listUsers: () => request('GET', '/api/users'),
  createUser: (data) => request('POST', '/api/users', data),
  updateUser: (id, data) => request('PATCH', `/api/users/${id}`, data),
  deleteUser: (id) => request('DELETE', `/api/users/${id}`),

  // spaces
  listSpaces: () => request('GET', '/api/spaces'),
  createSpace: (data) => request('POST', '/api/spaces', data),
  updateSpace: (id, data) => request('PATCH', `/api/spaces/${id}`, data),
  deleteSpace: (id) => request('DELETE', `/api/spaces/${id}`),

  // folders
  listFolders: (spaceId) => request('GET', `/api/folders?spaceId=${spaceId}`),
  createFolder: (data) => request('POST', '/api/folders', data),
  updateFolder: (id, data) => request('PATCH', `/api/folders/${id}`, data),
  deleteFolder: (id) => request('DELETE', `/api/folders/${id}`),
  reorderFolder: (id, direction) => request('POST', `/api/folders/${id}/reorder`, { direction }),
  sortFolders: (spaceId, parentId, order) => request('POST', '/api/folders/sort', { spaceId, parentId, order }),

  // presentations
  listPresentations: (folderId, sortBy, sortOrder) =>
    request('GET', `/api/presentations?folderId=${folderId}${sortBy ? `&sortBy=${sortBy}` : ''}${sortOrder ? `&sortOrder=${sortOrder}` : ''}`),
  getPresentation: (id) => request('GET', `/api/presentations/${id}`),
  uploadPresentation: (formData) => request('POST', '/api/presentations', formData),
  // Загрузка с отслеживанием прогресса передачи байтов — fetch не даёт событий upload progress,
  // поэтому здесь отдельно XMLHttpRequest. onProgress(fraction 0..1) вызывается по ходу загрузки.
  uploadPresentationWithProgress: (formData, onProgress) =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', apiBase() + '/api/presentations');
      xhr.withCredentials = true;
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
      });
      xhr.addEventListener('load', () => {
        let data = null;
        try {
          data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
        } catch {
          data = null;
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(data);
        } else {
          const message = (data && data.error) || `Ошибка запроса (${xhr.status})`;
          const err = new Error(message);
          err.status = xhr.status;
          reject(err);
        }
      });
      xhr.addEventListener('error', () => reject(new Error('Сетевая ошибка при загрузке')));
      xhr.addEventListener('abort', () => reject(new Error('Загрузка отменена')));
      xhr.send(formData);
    }),
  updateSummary: (id, summaryText) => request('PATCH', `/api/presentations/${id}/summary`, { summaryText }),
  movePresentation: (id, folderId) => request('PATCH', `/api/presentations/${id}/move`, { folderId }),
  deletePresentation: (id) => request('DELETE', `/api/presentations/${id}`),
  downloadPresentationUrl: (id) => apiBase() + `/api/presentations/${id}/download`,

  // slides
  updateSlide: (id, data) => request('PATCH', `/api/slides/${id}`, data),

  // search — поиск всегда в одном активном пространстве
  search: (q, spaceId) => request('GET', `/api/search?q=${encodeURIComponent(q)}${spaceId ? `&spaceId=${spaceId}` : ''}`),

  // build
  buildPresentation: (slideIds, queryText) => request('POST', '/api/build', { slideIds, queryText }),
  buildDownloadUrl: (id) => apiBase() + `/api/build/${id}/download`,
};

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

  // presentations
  listPresentations: (folderId) => request('GET', `/api/presentations?folderId=${folderId}`),
  getPresentation: (id) => request('GET', `/api/presentations/${id}`),
  uploadPresentation: (formData) => request('POST', '/api/presentations', formData),
  updateSummary: (id, summaryText) => request('PATCH', `/api/presentations/${id}/summary`, { summaryText }),
  movePresentation: (id, folderId) => request('PATCH', `/api/presentations/${id}/move`, { folderId }),
  deletePresentation: (id) => request('DELETE', `/api/presentations/${id}`),
  downloadPresentationUrl: (id) => apiBase() + `/api/presentations/${id}/download`,

  // slides
  updateSlide: (id, data) => request('PATCH', `/api/slides/${id}`, data),

  // search
  search: (q, spaceIds) => request('GET', `/api/search?q=${encodeURIComponent(q)}&spaces=${spaceIds.join(',')}`),

  // build
  buildPresentation: (slideIds, queryText) => request('POST', '/api/build', { slideIds, queryText }),
  buildDownloadUrl: (id) => apiBase() + `/api/build/${id}/download`,
};

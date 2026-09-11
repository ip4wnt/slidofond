// Минимальный helper для декларативного построения DOM без фреймворков.
// h('div', {class:'card', onClick: fn}, [h('span', {}, 'text'), otherNode])
export function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'class') {
      el.className = value;
    } else if (key === 'html') {
      el.innerHTML = value;
    } else if (key === 'dataset') {
      Object.entries(value).forEach(([k, v]) => (el.dataset[k] = v));
    } else if (key in el && typeof el[key] !== 'object') {
      el[key] = value;
    } else {
      el.setAttribute(key, value);
    }
  }
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child === null || child === undefined || child === false) continue;
    el.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(child) : child);
  }
  return el;
}

// Заменяет всё содержимое контейнера одним узлом/списком узлов.
export function mount(container, node) {
  container.replaceChildren();
  container.appendChild(node);
}

export function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

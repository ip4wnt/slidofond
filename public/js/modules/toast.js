import { h } from './render.js';

let container = null;

function ensureContainer() {
  if (!container) {
    container = h('div', { class: 'toast-container' });
    document.body.appendChild(container);
  }
  return container;
}

export function showToast(message, type = 'default') {
  const el = ensureContainer();
  const node = h('div', { class: `toast ${type}` }, message);
  el.appendChild(node);
  setTimeout(() => node.remove(), 3800);
}

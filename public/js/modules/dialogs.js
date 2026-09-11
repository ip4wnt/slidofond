import { h } from './render.js';

function openOverlay(bodyBuilder) {
  return new Promise((resolve) => {
    const overlay = h('div', { class: 'modal-overlay' });
    function close(result) {
      overlay.remove();
      resolve(result);
    }
    overlay.appendChild(bodyBuilder(close));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close(null);
    });
    document.body.appendChild(overlay);
    const firstInput = overlay.querySelector('input, textarea');
    if (firstInput) {
      firstInput.focus();
      firstInput.select();
    }
  });
}

// Простой промпт для ввода текста (название папки и т.п.)
export function promptDialog({ title, label, initialValue = '', confirmLabel = 'Сохранить' }) {
  return openOverlay((close) => {
    let value = initialValue;
    const input = h('input', {
      type: 'text',
      value: initialValue,
      'data-testid': 'input-prompt-dialog',
      onKeydown: (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          close(input.value.trim());
        }
        if (e.key === 'Escape') close(null);
      },
    });
    return h('div', { class: 'modal-box' }, [
      h('div', { class: 'modal-header' }, [h('h3', {}, title)]),
      h('div', { class: 'modal-body' }, [h('div', { class: 'field' }, [h('label', {}, label), input])]),
      h('div', { class: 'modal-footer' }, [
        h('button', { class: 'btn btn-secondary', onClick: () => close(null) }, 'Отмена'),
        h('button', { class: 'btn btn-primary', 'data-testid': 'button-confirm-prompt', onClick: () => close(input.value.trim()) }, confirmLabel),
      ]),
    ]);
  });
}

// Диалог подтверждения (удаление и т.п.)
export function confirmDialog({ title, message, confirmLabel = 'Удалить', danger = true }) {
  return openOverlay((close) =>
    h('div', { class: 'modal-box' }, [
      h('div', { class: 'modal-header' }, [h('h3', {}, title)]),
      h('div', { class: 'modal-body' }, [h('p', {}, message)]),
      h('div', { class: 'modal-footer' }, [
        h('button', { class: 'btn btn-secondary', onClick: () => close(false) }, 'Отмена'),
        h(
          'button',
          { class: danger ? 'btn btn-danger' : 'btn btn-primary', 'data-testid': 'button-confirm-dialog', onClick: () => close(true) },
          confirmLabel
        ),
      ]),
    ])
  );
}

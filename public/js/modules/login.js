import { h, mount } from './render.js';
import { svgIcon } from './icons.js';

// Экран входа по макету Figma (страница 14-2): заголовок «Фонд слайдов», подписи над
// полями, поля-пилюли по центру и золотая круглая кнопка со стрелкой справа от формы.
export function renderLogin(container, { error, pending }, { onSubmit }) {
  const loginInput = h('input', {
    type: 'text', name: 'login', autocomplete: 'username', required: true, autofocus: true,
    disabled: !!pending, 'data-testid': 'input-login', 'aria-label': 'Логин',
  });
  const passwordInput = h('input', {
    type: 'password', name: 'password', autocomplete: 'current-password', required: true,
    disabled: !!pending, 'data-testid': 'input-password', 'aria-label': 'Пароль',
  });

  const form = h('form', {
    class: 'login-form',
    onSubmit: (e) => {
      e.preventDefault();
      onSubmit(loginInput.value.trim(), passwordInput.value);
    },
  }, [
    h('div', { class: 'field' }, [h('label', { for: 'login-field' }, 'Логин'), loginInput]),
    h('div', { class: 'field' }, [h('label', { for: 'password-field' }, 'Пароль'), passwordInput]),
    error && h('div', { class: 'form-error', role: 'alert' }, error),
    h('button', {
      type: 'submit', class: 'login-submit', disabled: !!pending, 'aria-label': 'Войти', 'data-testid': 'button-login',
    }, [pending ? h('div', { class: 'spinner' }) : svgIcon('arrowGo')]),
  ]);
  loginInput.id = 'login-field';
  passwordInput.id = 'password-field';

  const card = h('div', { class: 'login-card' }, [
    h('h1', {}, 'Фонд слайдов'),
    form,
  ]);

  mount(container, h('div', { class: 'login-view' }, [card]));
  setTimeout(() => loginInput.focus(), 0);
}

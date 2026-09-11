import { h, mount } from './render.js';

export function renderLogin(container, { error, pending }, actions) {
  const view = h('div', { class: 'login-view' }, [
    h('div', { class: 'login-card' }, [
      h('div', { class: 'brand-mark', html: `<svg viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#1f6f4f"/><path d="M8 10h16v12H8z" fill="none" stroke="#fff" stroke-width="2"/><path d="M8 14h16" stroke="#fff" stroke-width="2"/></svg>` }),
      h('h1', {}, 'Вход в SlideVault'),
      h(
        'form',
        {
          onSubmit: (e) => {
            e.preventDefault();
            const form = e.target;
            actions.onSubmit(form.login.value.trim(), form.password.value);
          },
        },
        [
          h('div', { class: 'field' }, [
            h('label', { for: 'login-input' }, 'Логин'),
            h('input', { id: 'login-input', name: 'login', type: 'text', required: true, autofocus: true, 'data-testid': 'input-login' }),
          ]),
          h('div', { class: 'field', style: 'margin-top:12px;' }, [
            h('label', { for: 'password-input' }, 'Пароль'),
            h('input', { id: 'password-input', name: 'password', type: 'password', required: true, 'data-testid': 'input-password' }),
          ]),
          error && h('div', { class: 'form-error', style: 'margin-top:12px;' }, error),
          h(
            'button',
            { class: 'btn btn-primary', type: 'submit', style: 'width:100%;justify-content:center;margin-top:20px;', disabled: pending, 'data-testid': 'button-login' },
            pending ? 'Входим…' : 'Войти'
          ),
        ]
      ),
    ]),
  ]);
  mount(container, view);
}

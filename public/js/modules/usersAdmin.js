import { h } from './render.js';
import { svgIcon } from './icons.js';

const ROLE_LABELS = { reader: 'Читатель', editor: 'Редактор', admin: 'Администратор' };

// Модалка управления пользователями (только для admin).
export function openUsersAdminDialog(users, actions) {
  const overlay = h('div', { class: 'modal-overlay' });
  function close() {
    overlay.remove();
  }

  function render() {
    const table = h('table', { class: 'users-table' }, [
      h('thead', {}, [
        h('tr', {}, [h('th', {}, 'Логин'), h('th', {}, 'Имя'), h('th', {}, 'Роль'), h('th', {}, '')]),
      ]),
      h(
        'tbody',
        {},
        users.map((u) =>
          h('tr', { 'data-testid': `row-user-${u.id}` }, [
            h('td', {}, u.login),
            h('td', {}, u.displayName),
            h('td', {}, [
              h(
                'select',
                {
                  class: 'role-select',
                  value: u.role,
                  'data-testid': `select-role-${u.id}`,
                  onChange: async (e) => {
                    await actions.onUpdateRole(u.id, e.target.value);
                  },
                },
                Object.entries(ROLE_LABELS).map(([value, label]) => h('option', { value, selected: value === u.role }, label))
              ),
            ]),
            h('td', {}, [
              h(
                'button',
                {
                  class: 'icon-btn btn-danger',
                  'aria-label': 'Удалить пользователя',
                  'data-testid': `button-delete-user-${u.id}`,
                  onClick: async () => {
                    if (await actions.onDelete(u.id, u.login)) {
                      users = users.filter((x) => x.id !== u.id);
                      render();
                    }
                  },
                },
                [svgIcon('trash')]
              ),
            ]),
          ])
        )
      ),
    ]);

    const createForm = h(
      'form',
      {
        style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:16px;',
        onSubmit: async (e) => {
          e.preventDefault();
          const f = e.target;
          const newUser = await actions.onCreate({
            login: f.login.value.trim(),
            password: f.password.value,
            displayName: f.displayName.value.trim(),
            role: f.role.value,
          });
          if (newUser) {
            users = [...users, newUser];
            render();
          }
        },
      },
      [
        h('input', { name: 'login', placeholder: 'Логин', required: true, style: 'flex:1;min-width:100px;padding:8px;border-radius:6px;border:1px solid var(--color-border);' }),
        h('input', { name: 'displayName', placeholder: 'Имя', required: true, style: 'flex:1;min-width:100px;padding:8px;border-radius:6px;border:1px solid var(--color-border);' }),
        h('input', { name: 'password', type: 'password', placeholder: 'Пароль', required: true, style: 'flex:1;min-width:100px;padding:8px;border-radius:6px;border:1px solid var(--color-border);' }),
        h(
          'select',
          { name: 'role', style: 'padding:8px;border-radius:6px;border:1px solid var(--color-border);' },
          Object.entries(ROLE_LABELS).map(([value, label]) => h('option', { value }, label))
        ),
        h('button', { class: 'btn btn-primary btn-sm', type: 'submit', 'data-testid': 'button-create-user' }, [svgIcon('plus'), 'Добавить']),
      ]
    );

    overlay.replaceChildren(
      h('div', { class: 'modal-box', style: 'max-width:720px;' }, [
        h('div', { class: 'modal-header' }, [h('h3', {}, 'Пользователи'), h('button', { class: 'icon-btn', onClick: close }, [svgIcon('x')])]),
        h('div', { class: 'modal-body' }, [table, createForm]),
      ])
    );
  }

  render();
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  document.body.appendChild(overlay);
  return close;
}

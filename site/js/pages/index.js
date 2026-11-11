/**
 * ROUTE TABLE — add a page by adding a line here and a file in this folder.
 *
 * Page contract (default export):
 *   title: string | (params) => string
 *   render({ el, params, query, app }) → optional cleanup function
 *
 * `permission` (string or array = any-of) hides the page from users who lack it.
 * The server enforces the same permissions on every API call; this is UX only.
 */
export const routes = [
  { path: '/dashboard', load: () => import('./dashboard.js') },
  { path: '/workorders', load: () => import('./workorders.js') },
  { path: '/workorders/new', load: () => import('./workorder-form.js'), permission: 'workorders.create' },
  { path: '/workorders/:id/edit', load: () => import('./workorder-form.js') },
  { path: '/workorders/:id', load: () => import('./workorder-detail.js') },
  { path: '/rounds', load: () => import('./rounds.js'), permission: 'rounds.manage' },
  { path: '/rounds/:id', load: () => import('./round.js'), permission: 'rounds.manage' },
  { path: '/compliance', load: () => import('./compliance.js'), permission: 'compliance.manage' },
  { path: '/reports', load: () => import('./reports.js'), permission: 'reports.view' },
  { path: '/profile', load: () => import('./profile.js') },
  { path: '/users', load: () => import('./users.js'), permission: ['users.view', 'users.manage'] },
  { path: '/users/:id', load: () => import('./user-detail.js'), permission: ['users.view', 'users.manage'] },
  { path: '/roles', load: () => import('./roles.js'), permission: 'roles.manage' },
  { path: '/settings', load: () => import('./settings.js'), permission: 'settings.manage' },
  { path: '/errors', load: () => import('./errors.js'), permission: 'errors.view' },
  { path: '/audit', load: () => import('./audit.js'), permission: 'audit.view' },
];

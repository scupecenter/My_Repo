import { http, passthrough } from 'msw';
import { API_BASE } from '@/api/client';
import { HYBRID, isHybrid } from '@/lib/hybrid';

/**
 * Hybrid mode: `VITE_USE_MOCKS=true` and `VITE_REAL_API=auth-users`. MSW lets exactly these method + path patterns
 * through to the real server; everything else (for example `/users/:id/assignments`) stays mocked.
 * Keep this the single list; the real API grows by adding lines here, and by changing `VITE_REAL_API` later.
 */
export const REAL_API_AUTH_USERS = [
  ['post', '/auth/local/login'],
  ['post', '/auth/local/password'],
  ['post', '/auth/local/step-up'],
  ['get', '/auth/session'],
  ['post', '/auth/logout'],
  ['get', '/me'],
  ['get', '/users'],
  ['get', '/users/picker'],
  ['get', '/users/deleted'],
  ['post', '/users'],
  ['get', '/users/:id'],
  ['patch', '/users/:id'],
  ['post', '/users/:id/password-reset'],
  ['post', '/users/:id/delete'],
  ['post', '/users/:id/restore'],
  ['get', '/groups'],
  ['get', '/groups/:id'],
  ['post', '/groups/:id/members'],
  ['delete', '/groups/:id/members/:userId'],
  // Contract 0.4.0: departments, direct manager, messages, announcements (ADR 0013).
  ['get', '/departments'],
  ['post', '/departments'],
  ['patch', '/departments/:id'],
  ['put', '/users/:id/org'],
  ['get', '/messages/contacts'],
  ['get', '/messages/threads'],
  ['post', '/messages/threads'],
  ['get', '/messages/threads/:id'],
  ['post', '/messages/threads/:id/replies'],
  ['post', '/messages/threads/:id/read'],
  ['get', '/announcements'],
  ['post', '/announcements'],
  ['get', '/announcements/:id'],
  ['get', '/announcements/:id/responses'],
  ['get', '/announcements/:id/responses/export'],
  ['post', '/announcements/:id/respond'],
  ['get', '/me/announcements/pending'],
  // Contract 0.4.0: regions, roles, permission profiles, assignments, delegations (apps/api: regions, roles, permissions, assignments, delegations).
  ['get', '/regions'],
  ['get', '/roles'],
  ['post', '/roles'],
  ['get', '/roles/:id'],
  ['patch', '/roles/:id'],
  ['get', '/permissions/catalogue'],
  ['get', '/permission-profiles'],
  ['post', '/permission-profiles'],
  ['get', '/permission-profiles/:id'],
  ['put', '/permission-profiles/:id'],
  ['get', '/users/:id/assignments'],
  ['get', '/assignments'],
  ['post', '/assignments/bulk-assign'],
  ['post', '/assignments/bulk-update'],
  ['post', '/assignments/bulk-end'],
  ['post', '/assignments/copy'],
  ['get', '/delegations'],
  ['post', '/delegations'],
  ['post', '/delegations/:id/revoke'],
  // Contract 0.4.1: Site Register with streams, tasks and approvals (apps/api: sites, workflow; migration 0015).
  // Document slots, file upload and templates are not in the API yet and stay mocked.
  ['get', '/sites'],
  ['get', '/sites/:id'],
  ['get', '/sites/:id/tasks'],
  ['get', '/tasks/:id'],
  ['patch', '/tasks/:id'],
  ['post', '/tasks/:id/start'],
  ['post', '/tasks/:id/submit'],
  ['post', '/tasks/:id/review'],
  ['post', '/tasks/:id/approve'],
  ['post', '/tasks/:id/reject'],
  ['post', '/tasks/:id/claim'],
  ['post', '/tasks/:id/release'],
  ['get', '/tasks/:id/history'],
  ['get', '/tasks/:id/comments'],
  ['post', '/tasks/:id/comments'],
  ['get', '/approvals'],
  ['post', '/approvals/bulk'],
  // Contract 0.4.6: the Responsibility Matrix, stage rows and the register and Dismantle rows (apps/api: matrix; migration 0020).
  ['get', '/matrix'],
  ['patch', '/matrix'],
  // Contract 0.4.5: the register framework and its first four registers (apps/api: registers; migration 0019), every action the API implements.
  // Template entry (`/templates`, `/import-batches`) is not built in the API yet and stays mocked.
  ['get', '/registers'],
  ['get', '/registers/:key/records'],
  ['post', '/registers/:key/records'],
  ['get', '/registers/:key/records/:id'],
  ['patch', '/registers/:key/records/:id'],
  ['post', '/registers/:key/records/:id/submit'],
  ['post', '/registers/:key/records/:id/review'],
  ['post', '/registers/:key/records/:id/approve'],
  ['post', '/registers/:key/records/:id/reject'],
  ['post', '/registers/:key/records/:id/claim'],
  ['post', '/registers/:key/records/:id/release'],
  ['post', '/registers/:key/records/:id/void'],
  ['get', '/registers/:key/records/:id/history'],
  ['get', '/registers/:key/records/:id/versions'],
  ['post', '/registers/:key/records/:id/versions'],
] as const;

/** `GET /users/deleted` and `GET /users/picker` are other operations that the `:id` pattern would swallow; they stay mocked. */
const NOT_AN_ID = new Set(['deleted', 'picker']); // picker has its own line above

export { HYBRID, isHybrid };

/** MSW handlers that pass the listed calls through to the network. Empty unless hybrid. */
export function realApiHandlers(on = HYBRID) {
  if (!on) return [];
  return REAL_API_AUTH_USERS.map(([method, path]) =>
    http[method](`${API_BASE}${path}`, ({ params }) => (path === '/users/:id' && NOT_AN_ID.has(String(params.id)) ? undefined : passthrough())),
  );
}

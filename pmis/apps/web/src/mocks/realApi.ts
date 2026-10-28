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

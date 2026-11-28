/**
 * What a guest account (migration 0731) may call. Deny by default: a guest reads, never writes. The database already limits what a guest can see
 * (role GUEST, profile guest_view, chosen regions and modules); this list is a second lock in front of it, so a route that forgets its own permission check
 * still stays closed to a guest.
 *
 * Reads: the session and the profile screen, the project data screens (sites, Site Master, registers, dashboard, reports, project status) and the
 * shell lookups those screens need (regions, UI settings). Writes: only sign-out and the password change of the guest's own account.
 * Everything else is refused with 403 guest_read_only: people, messages, announcements, exports and downloads, imports, settings, logs, admin.
 */
const READ_PREFIXES = [
  '/auth/session', '/me', '/regions', '/ui', '/health',
  '/sites', '/site-master', '/site360', '/registers', '/dashboard', '/reports', '/project-status', '/warehouse', '/as-built',
  '/notifications/unread-count', '/nav-layout', '/settings/nav-layout', '/settings/ui-features', '/settings/identity',
];
const WRITE_PATHS = new Set(['/auth/logout', '/auth/local/password']);
/** Parts of a read prefix that stay closed: file downloads, exports, the people lists and anything that is a write in disguise. */
const READ_DENY = [/\/(download|downloads|export|exports|zip|files|documents\/[^/]+\/(download|content))(\/|$)/, /^\/me\/announcements/, /^\/me\/messages/];

export function guestMayCall(method: string, path: string): boolean {
  if (method === 'POST' || method === 'DELETE' || method === 'PUT' || method === 'PATCH') return WRITE_PATHS.has(path);
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') return false;
  if (READ_DENY.some((re) => re.test(path))) return false;
  return READ_PREFIXES.some((p) => path === p || path.startsWith(p + '/') || path.startsWith(p + '?'));
}

/** The route path without the API prefix and the query string, for guestMayCall. */
export function apiPath(originalUrl: string): string {
  const noQuery = originalUrl.split('?')[0] ?? '';
  return noQuery.replace(/^\/api\/v1(?=\/|$)/, '').replace(/\/+$/, '') || '/';
}

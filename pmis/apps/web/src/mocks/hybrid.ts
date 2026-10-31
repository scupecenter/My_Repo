import type { QueryClient } from '@tanstack/react-query';
import type { Session } from '@/api/types';
import { db, save } from './db';

/**
 * Hybrid mode: the real server owns the session. While it is authenticated the mock session is the demo Project Manager,
 * so the screens that still use sample data work. Signing out of the real session clears the mock one.
 */
export function syncMockSession(authenticated: boolean) {
  const d = db();
  if (authenticated) {
    if (d.session?.account === 'pm' && d.session.method === 'local') return;
    d.session = { account: 'pm', linked: true, stepupAt: null, method: 'local' };
  } else if (d.session) d.session = null;
  else return;
  save();
}

export function watchRealSession(qc: QueryClient) {
  return qc.getQueryCache().subscribe((e) => {
    if (e.query.queryKey[0] !== 'session' || e.query.queryKey.length !== 1) return;
    if (e.type === 'removed') return syncMockSession(false);
    const s = e.query.state.data as Session | undefined;
    if (s) syncMockSession(s.authenticated);
  });
}

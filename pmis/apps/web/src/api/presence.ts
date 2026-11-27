import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api } from './client';

/**
 * Soft "… is editing this record" notice (contract 0.15.246, migration 0345; owner request 2026-11-27, research item 17). Advisory only:
 * nothing is locked. While the caller has a record open for editing, a heartbeat (30 s) keeps their row fresh (stale after 2 minutes), a stop
 * call removes it at once when the editor closes, and a poll (30 s, `X-PMIS-Live: 1`, so the timer never extends the idle timeout) lists the
 * other current editors. V1 covers register records (kind `record`).
 */
export type EditPresenceEditor = { id: string; display_name: string; employee_id: string | null; since: string };

const KEY = (kind: string, id: string) => ['edit-presence', kind, id] as const;
const LIVE = { headers: { 'X-PMIS-Live': '1' } };

export function useEditPresence(kind: 'record' | 'task', id: string | null | undefined, editing: boolean) {
  const qc = useQueryClient();
  const active = editing && !!id;
  useEffect(() => {
    if (!active || !id) return;
    const ping = () => void api.post('/presence/editing', { body: { kind, entity_id: id } }).catch(() => undefined);
    ping();
    const timer = window.setInterval(ping, 30_000);
    return () => {
      window.clearInterval(timer);
      void api.post('/presence/editing/stop', { body: { kind, entity_id: id } }).catch(() => undefined);
      void qc.invalidateQueries({ queryKey: KEY(kind, id) });
    };
  }, [active, kind, id]); // eslint-disable-line react-hooks/exhaustive-deps
  return useQuery({
    queryKey: KEY(kind, id ?? ''),
    enabled: !!id,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    queryFn: () => api.get<{ editors: EditPresenceEditor[] }>('/presence/editing', { query: { kind, entity_id: id! }, ...LIVE }).then((r) => r.editors),
  });
}

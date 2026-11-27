import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Camera, CloudOff, Image as ImageIcon, RefreshCw, Send, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useFieldPwaSettings, useFieldWorker, useOnline } from '@/api/fieldPwa';
import { useMe } from '@/api/hooks';
import { api } from '@/api/client';
import type { Snag } from '@/api/qc';
import type { TaskSummary } from '@/api/types';
import { PageHeader } from '@/components/PageHeader';
import { useToast } from '@/components/Toast';
import { enqueue, indexedDbStore, memoryStore, snapshotFresh, type FieldAction, type FieldStore } from '@/lib/fieldOutbox';
import { apiSender, syncOutbox } from '@/lib/fieldSync';

/**
 * Field mode (contract 0.15.340, migration 0411): a narrow screen for site teams with a weak connection. It shows the person's tasks and the snags of a site,
 * takes a photo of the fix and submits the fix; each action is queued on the device and sent when there is a connection (see lib/fieldSync.ts for the rules).
 * Approving or rejecting a snag is not here: it stays with L2 and is never done offline.
 * Lists are read online and kept on the device (the last read, for the cache hours of the setting); offline the last read shows with its age.
 */
type Page<T> = { items: T[] };
const BUCKETS = ['late', 'do_now', 'waiting'] as const;

/** Reads online and keeps the answer; when the read fails (no connection) the kept answer is returned if it is still fresh. */
function useKept<T>(store: FieldStore | null, key: string, cacheHours: number, enabled: boolean, read: () => Promise<T>) {
  return useQuery<{ data: T; at: string | null; offline: boolean } | null>({
    queryKey: ['field', key, !!store], enabled: enabled && !!store, retry: false, staleTime: 15_000,
    queryFn: async () => {
      try {
        const data = await read();
        await store!.putSnapshot(key, data);
        return { data, at: null, offline: false };
      } catch (e) {
        const snap = await store!.getSnapshot(key);
        if (snapshotFresh(snap, cacheHours)) return { data: snap!.data as T, at: snap!.at, offline: true };
        throw e;
      }
    },
  });
}

const geo = (): Promise<{ lat: number; lon: number } | null> => new Promise((res) => {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return res(null);
  navigator.geolocation.getCurrentPosition((p) => res({ lat: p.coords.latitude, lon: p.coords.longitude }), () => res(null), { timeout: 5000, maximumAge: 60_000 });
});

export function Field() {
  const { t } = useTranslation();
  const toast = useToast();
  const qc = useQueryClient();
  const me = useMe(true).data;
  const cfg = useFieldPwaSettings();
  const online = useOnline();
  useFieldWorker(cfg.enabled);
  const store = useMemo<FieldStore | null>(() => (me ? (typeof indexedDB === 'undefined' ? memoryStore() : indexedDbStore(me.user.id)) : null), [me]);
  const [queue, setQueue] = useState<FieldAction[]>([]);
  // auto-fill: the site last worked on (only its id, kept on this device)
  const siteKey = `gsdn-field-site-${me?.user.id ?? ''}`;
  const [siteId, setSiteIdRaw] = useState<string | null>(null);
  const setSiteId = (v: string | null) => { setSiteIdRaw(v); try { if (v) localStorage.setItem(siteKey, v); else localStorage.removeItem(siteKey); } catch { /* storage may be blocked */ } };
  useEffect(() => { if (me) { try { setSiteIdRaw((cur) => cur ?? localStorage.getItem(siteKey)); } catch { /* ignore */ } } }, [me, siteKey]);
  const syncing = useRef(false);

  const reload = useCallback(async () => { if (store) setQueue(await store.list()); }, [store]);
  const sync = useCallback(async () => {
    if (!store || syncing.current) return;
    syncing.current = true;
    try {
      const r = await syncOutbox(store, apiSender);
      if (r.sent) { void qc.invalidateQueries({ queryKey: ['field'] }); toast(t('field.synced', { count: r.sent })); }
    } finally { syncing.current = false; await reload(); }
  }, [store, qc, toast, t, reload]);

  useEffect(() => { void reload(); }, [reload]);
  const waiting = queue.filter((a) => a.state === 'waiting').length;
  // a sync on opening, when the connection comes back, and every few seconds while something waits
  useEffect(() => { if (cfg.enabled && online && waiting) void sync(); }, [cfg.enabled, online, waiting, sync]);
  useEffect(() => {
    if (!cfg.enabled || !online || !waiting) return;
    const id = window.setInterval(() => { void sync(); }, cfg.sync_seconds * 1000);
    return () => window.clearInterval(id);
  }, [cfg.enabled, cfg.sync_seconds, online, waiting, sync]);

  const tasks = useKept<TaskSummary[]>(store, 'my-tasks', cfg.cache_hours, cfg.enabled, async () => {
    const pages = await Promise.all(BUCKETS.map((b) => api.get<Page<TaskSummary>>('/me/tasks', { query: { bucket: b, limit: 100 } })));
    const seen = new Map<string, TaskSummary>();
    pages.forEach((p) => p.items.forEach((x) => seen.set(x.id, x)));
    return [...seen.values()];
  });
  const sites = useMemo(() => {
    const m = new Map<string, string>();
    (tasks.data?.data ?? []).forEach((x) => m.set(x.site_id, x.site_code));
    return [...m.entries()].map(([id, code]) => ({ id, code })).sort((a, b) => a.code.localeCompare(b.code));
  }, [tasks.data]);
  const snags = useKept<Snag[]>(store, `snags:${siteId ?? ''}`, cfg.cache_hours, cfg.enabled && !!siteId, async () => (await api.get<Page<Snag>>(`/sites/${siteId}/snags`, { query: { limit: 200 } })).items);

  async function add(snag: Snag, kind: 'photo' | 'submit', file?: File, inApp = false) {
    if (!store) return;
    const pos = file ? await geo() : null;
    const r = await enqueue(store, kind === 'photo'
      ? { kind: 'snag_photo', snagId: snag.id, snagLabel: `${snag.site_code} ${snag.title ?? ''}`.trim(), blob: file, fileName: file?.name, capturedAt: new Date().toISOString(), lat: pos?.lat ?? null, lon: pos?.lon ?? null, inAppCamera: inApp }
      : { kind: 'snag_submit', snagId: snag.id, snagLabel: `${snag.site_code} ${snag.title ?? ''}`.trim() }, cfg);
    if (!r.ok) { toast(t(r.reason === 'queue_full' ? 'field.queue_full' : 'field.too_large', { max: cfg.max_photo_mb })); return; }
    await reload();
    toast(t('field.queued'));
    if (online) void sync();
  }
  async function discard(a: FieldAction) { await store?.remove(a.id); await reload(); }

  if (!cfg.enabled) {
    return (
      <div className="space-y-3" data-testid="page-field">
        <PageHeader title={t('field.title')} settings="field_pwa" />
        <p className="card p-4 text-mute" data-testid="field-off">{t('field.off')}</p>
      </div>
    );
  }
  const pendingOf = (id: string) => queue.filter((a) => a.snagId === id && a.state !== 'done');
  return (
    <div className="space-y-4" data-testid="page-field">
      <PageHeader title={t('field.title')} subtitle={t('field.subtitle')} settings="field_pwa" />
      {!online && <p role="status" className="card flex items-center gap-2 p-3 text-waitInk" data-testid="field-offline"><CloudOff size={16} aria-hidden />{t('field.offline')}</p>}
      {(tasks.data?.offline || snags.data?.offline) && <p className="text-sm text-mute" data-testid="field-stale">{t('field.stale', { at: new Date((tasks.data?.at ?? snags.data?.at) as string).toLocaleString() })}</p>}

      <section className="card space-y-2 p-4" data-testid="field-queue">
        <div className="flex items-center gap-2">
          <h2 className="font-bold">{t('field.queue_title')}</h2>
          <span className="chip bg-card text-ink" data-testid="field-waiting">{waiting}</span>
          <button type="button" className="btn ms-auto" disabled={!online || !waiting} onClick={() => void sync()} data-testid="field-sync"><RefreshCw size={14} aria-hidden />{t('field.sync_now')}</button>
        </div>
        {queue.filter((a) => a.state !== 'done').length === 0 && <p className="text-sm text-mute">{t('field.queue_empty')}</p>}
        {queue.filter((a) => a.state !== 'done').map((a) => (
          <div key={a.id} className="flex flex-wrap items-center gap-2 border-t border-line pt-2 text-sm" data-testid={`field-action-${a.state}`}>
            <span>{t(a.kind === 'snag_photo' ? 'field.k_photo' : 'field.k_submit')}</span>
            <span className="text-mute">{a.snagLabel}</span>
            <span className={`chip ${a.state === 'attention' ? 'bg-lateBg text-lateInk' : 'bg-waitBg text-waitInk'}`}>{t(`field.s_${a.state}`)}</span>
            {a.state === 'attention' && <span className="text-lateInk" data-testid="field-reason">{t(`field.r_${a.reason}`, { defaultValue: a.message || a.reason || '' })}{a.message && a.reason && !['earlier_failed', 'retries_exhausted'].includes(a.reason) ? `: ${a.message}` : ''}</span>}
            {a.state === 'attention' && <button type="button" className="btn ms-auto" onClick={() => void discard(a)} data-testid="field-discard"><Trash2 size={14} aria-hidden />{t('field.discard')}</button>}
          </div>
        ))}
      </section>

      <section className="card space-y-2 p-4" data-testid="field-tasks">
        <h2 className="font-bold">{t('field.tasks_title')}</h2>
        {tasks.isError && <p role="alert" className="text-lateInk">{t('field.no_data')}</p>}
        {tasks.data && (tasks.data.data.length === 0 ? <p className="text-sm text-mute">{t('field.tasks_none')}</p> : (
          <ul className="space-y-1">
            {tasks.data.data.slice(0, 60).map((x) => (
              <li key={x.id} className="flex flex-wrap items-center gap-2 text-sm" data-testid="field-task">
                <Link to={`/sites/${x.site_id}`} className="font-mono text-link">{x.site_code}</Link>
                <span>{x.name_en}</span><span className="chip bg-card text-ink">{x.state}</span>
                {x.planned_date && <span className="text-mute">{x.planned_date}</span>}
              </li>
            ))}
          </ul>
        ))}
      </section>

      <section className="card space-y-3 p-4" data-testid="field-snags">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-bold">{t('field.snags_title')}</h2>
          <select className="input" aria-label={t('field.pick_site')} data-testid="field-site" value={siteId ?? ''} onChange={(e) => setSiteId(e.target.value || null)}>
            <option value="">{t('field.pick_site')}</option>
            {sites.map((s) => <option key={s.id} value={s.id}>{s.code}</option>)}
          </select>
        </div>
        {snags.isError && <p role="alert" className="text-lateInk">{t('field.no_data')}</p>}
        {snags.data && snags.data.data.filter((s) => s.state === 'open' || s.state === 'fix_submitted').map((s) => {
          const can = (s.allowed_actions ?? []).includes('upload') || (s.allowed_actions ?? []).includes('submit');
          const mine = pendingOf(s.id);
          return (
            <article key={s.id} className="space-y-2 border-t border-line pt-2" data-testid="field-snag">
              <div className="flex flex-wrap items-center gap-2"><b>{s.title ?? s.snag_type.code}</b><span className="chip bg-card text-ink">{s.state}</span>{mine.length > 0 && <span className="chip bg-waitBg text-waitInk">{t('field.pending', { count: mine.length })}</span>}</div>
              {(s.photos_missing ?? []).length > 0 && <p className="text-sm text-mute">{t('field.photos_missing', { count: (s.photos_required ?? 0) - (s.photos?.length ?? 0) })}</p>}
              {can ? (
                <div className="flex flex-wrap gap-2">
                  <label className="btn cursor-pointer" data-testid="field-take"><Camera size={14} aria-hidden />{t('field.take_photo')}
                    <input type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void add(s, 'photo', f, true); }} /></label>
                  <label className="btn cursor-pointer" data-testid="field-gallery"><ImageIcon size={14} aria-hidden />{t('field.from_gallery')}
                    <input type="file" accept="image/*" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void add(s, 'photo', f, false); }} /></label>
                  <button type="button" className="btn btn-accent" data-testid="field-submit" onClick={() => void add(s, 'submit')}><Send size={14} aria-hidden />{t('field.submit_fix')}</button>
                </div>
              ) : <p className="text-sm text-mute">{t('field.no_rights')}</p>}
            </article>
          );
        })}
        {snags.data && snags.data.data.filter((s) => s.state === 'open' || s.state === 'fix_submitted').length === 0 && <p className="text-sm text-mute">{t('field.snags_none')}</p>}
      </section>
    </div>
  );
}

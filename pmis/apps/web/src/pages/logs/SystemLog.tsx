import * as Dialog from '@radix-ui/react-dialog';
import { Copy, Download, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useMe } from '@/api/hooks';
import { EMPTY_SYS_FILTER, SYS_LEVELS, SYS_SOURCES, useSystemLog, type SysFilter, type SystemLogEntry } from '@/api/logs';
import { DrawerFrame } from '@/components/DrawerFrame';
import { Who } from '@/components/logs/bits';
import { LogTable } from '@/components/logs/LogTable';
import { SavedViews } from '@/components/logs/SavedViews';
import { PageHeader, Toolbar } from '@/components/PageHeader';
import { ActiveChips, ColumnMenu, useTablePrefs, type Chip } from '@/components/TableKit';
import { useToast } from '@/components/Toast';
import { hasGrant, isAdmin } from '@/lib/perm';
import type { ColDef } from '@/lib/tablePrefs';
import { csvCell } from './ActivityReport';

/**
 * System Log (owner request 2026-11-09, contract 0.15.2): errors and warnings of the server, the importer, template checks and mail, for a System Admin or
 * `view` on `admin.system_log` (the API answers 403 to anyone else). A row opens a drawer with the full message and the stored context. The context is data
 * typed by the server or copied from an uploaded file: it is only ever shown as text, never as markup.
 */
const DEFS: ColDef[] = [
  { id: 'at', w: 170, min: 120, pinned: true }, { id: 'level', w: 100, min: 70 }, { id: 'source', w: 140, min: 80 }, { id: 'message', w: 380, min: 160 },
  { id: 'user', w: 200, min: 110 }, { id: 'request', w: 150, min: 80 }, { id: 'route', w: 200, min: 90, off: true }, { id: 'id', w: 80, min: 50, off: true },
];
const TONE: Record<string, string> = { error: 'bg-lateBg text-lateInk', warn: 'bg-waitBg text-waitInk', info: 'bg-openBg text-openInk' };

const TRIPOLI = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tripoli', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
/** `YYYY-MM-DD HH:mm:ss` on the Tripoli clock (digits always Latin, so the column lines up in both languages). */
export function tripoliStamp(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = Object.fromEntries(TRIPOLI.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/** A stored value as plain text: strings as they are, everything else as indented JSON. */
export const ctxText = (v: unknown): string => (typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v, null, 2) ?? String(v));

export function LevelChip({ level, testid }: { level: string; testid?: string }) {
  const { t } = useTranslation();
  return <span className={`chip ${TONE[level] ?? 'bg-card2'}`} data-level={level} data-testid={testid}>{t(`syslog.level_${level}`, { defaultValue: level })}</span>;
}

/** The context as a key/value list; nested objects and lists as pretty JSON in a preformatted block. Text only (React escapes it). */
export function ContextList({ ctx }: { ctx?: Record<string, unknown> | null }) {
  const { t } = useTranslation();
  const keys = ctx && typeof ctx === 'object' && !Array.isArray(ctx) ? Object.keys(ctx) : [];
  if (!keys.length) return <p className="text-mute" data-testid="syslog-ctx-empty">{t('syslog.no_context')}</p>;
  return (
    <dl className="divide-y divide-line rounded-md border border-line" data-testid="syslog-ctx">
      {keys.map((k) => {
        const v = ctx![k];
        const nested = v !== null && typeof v === 'object';
        return (
          <div key={k} className="grid gap-1 p-2 sm:grid-cols-[minmax(8rem,max-content)_1fr]" data-testid={`syslog-ctx-${k}`}>
            <dt className="mono text-xs text-mute" dir="ltr">{k}</dt>
            <dd className="min-w-0">
              {nested
                ? <pre className="mono overflow-x-auto whitespace-pre-wrap break-words rounded bg-card2 p-2 text-xs" dir="ltr" data-testid={`syslog-ctx-val-${k}`}>{ctxText(v)}</pre>
                : <span className="mono whitespace-pre-wrap break-words text-xs" dir="auto" data-testid={`syslog-ctx-val-${k}`}>{v === null ? 'null' : ctxText(v)}</span>}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

const KV = ({ k, v, id }: { k: string; v: ReactNode; id: string }) => <div className="flex justify-between gap-3 border-b border-line py-1" data-testid={`sd-${id}`}><span className="text-mute">{k}</span><span className="min-w-0 break-words text-end">{v}</span></div>;

/** The text the copy button puts on the clipboard: the whole row as indented JSON. */
export const entryText = (r: SystemLogEntry) => JSON.stringify({ id: r.id, at: r.at, level: r.level, source: r.source, code: r.code ?? null, message: r.message,
  request_id: r.request_id ?? null, route: r.route ?? null, user: r.user ? { display_name: r.user.display_name, employee_id: r.user.employee_id ?? null } : null, context: r.details ?? null }, null, 2);

function Detail({ r, onClose }: { r: SystemLogEntry; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const copy = () => {
    const done = () => toast(t('syslog.copied'));
    const fail = () => toast(t('syslog.copy_failed'), 'err');
    try { void (navigator.clipboard?.writeText(entryText(r)) ?? Promise.reject(new Error('no clipboard'))).then(done, fail); } catch { fail(); }
  };
  return (
    <div className="flex h-full flex-col" data-testid="syslog-drawer-body">
      <header className="flex items-start gap-2 border-b border-line p-4">
        <div className="min-w-0 flex-1">
          <Dialog.Title className="flex flex-wrap items-center gap-2 font-bold"><LevelChip level={r.level} /><span className="mono" dir="ltr">{r.source}</span> <span className="text-mute">#{r.id}</span></Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-mute"><span dir="ltr">{tripoliStamp(r.at)}</span></Dialog.Description>
        </div>
        <button className="btn" data-testid="syslog-copy" onClick={copy}><Copy size={14} aria-hidden />{t('syslog.copy')}</button>
        <Dialog.Close asChild><button className="btn px-2" aria-label={t('common.close')} data-testid="syslog-drawer-close" onClick={onClose}><X size={16} /></button></Dialog.Close>
      </header>
      <div className="flex-1 space-y-4 overflow-y-auto p-4 text-sm">
        <section aria-labelledby="sd-msg-h">
          <h3 id="sd-msg-h" className="mb-1 font-semibold">{t('syslog.full_message')}</h3>
          <p className="mono whitespace-pre-wrap break-words rounded-md bg-card2 p-2 text-xs" dir="auto" data-testid="syslog-message">{r.message}</p>
        </section>
        <section aria-label={t('syslog.c_user')}>
          <KV id="user" k={t('syslog.c_user')} v={r.user ? <Who a={r.user} /> : t('syslog.system')} />
          <KV id="request" k={t('syslog.c_request')} v={<span className="mono text-xs" dir="ltr">{r.request_id ?? '—'}</span>} />
          <KV id="route" k={t('syslog.c_route')} v={<span className="mono text-xs" dir="ltr">{r.route ?? '—'}</span>} />
          {r.code && <KV id="code" k={t('syslog.c_code')} v={<span className="mono text-xs" dir="ltr">{r.code}</span>} />}
        </section>
        <section aria-labelledby="sd-ctx-h">
          <h3 id="sd-ctx-h" className="mb-1 font-semibold">{t('syslog.context')}</h3>
          <ContextList ctx={r.details} />
        </section>
      </div>
    </div>
  );
}

/** CSV of the rows on screen (the current filters), built in the browser; a leading = + - @ is neutralised. */
export function systemLogCsv(rows: SystemLogEntry[]): string {
  const head = ['id', 'at_tripoli', 'level', 'source', 'message', 'user', 'employee_id', 'request_id', 'route', 'context'];
  const body = rows.map((r) => [r.id, tripoliStamp(r.at), r.level, r.source, r.message, r.user?.display_name ?? '', r.user?.employee_id ?? '', r.request_id ?? '', r.route ?? '', r.details ? JSON.stringify(r.details) : '']);
  return '﻿' + [head, ...body].map((l) => l.map(csvCell).join(',')).join('\n');
}

function L({ k, children }: { k: string; children: ReactNode }) {
  const { t } = useTranslation();
  return <label className="block text-sm font-semibold">{t(k)}<div className="mt-1 font-normal">{children}</div></label>;
}

function Filters({ f, set }: { f: SysFilter; set: (f: SysFilter) => void }) {
  const { t } = useTranslation();
  const up = (p: Partial<SysFilter>) => set({ ...f, ...p });
  const rows: ([string, string, Partial<SysFilter>] | false | '')[] = [
    f.level && ['level', `${t('syslog.f_level')}: ${t(`syslog.level_${f.level}`, { defaultValue: f.level })}`, { level: '' }],
    f.source && ['source', `${t('syslog.f_source')}: ${f.source}`, { source: '' }],
    f.from && ['from', `${t('syslog.f_from')}: ${f.from}`, { from: '' }],
    f.to && ['to', `${t('syslog.f_to')}: ${f.to}`, { to: '' }],
    f.q && ['q', `${t('syslog.f_search')}: ${f.q}`, { q: '' }],
  ];
  const chips: Chip[] = rows.filter((x): x is [string, string, Partial<SysFilter>] => !!x).map(([key, label, patch]) => ({ key, label, onRemove: () => up(patch) }));
  return (
    <section className="card mb-3 space-y-3 p-3" data-testid="syslog-filters" aria-label={t('logs.filters')}>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-48 flex-1"><L k="syslog.f_search"><input className="input" type="search" data-testid="syslog-q" placeholder={t('syslog.f_search_hint')} value={f.q} onChange={(e) => up({ q: e.target.value })} /></L></div>
        <L k="syslog.f_level"><select className="input" data-testid="syslog-level" value={f.level} onChange={(e) => up({ level: e.target.value })}><option value="">{t('common.all')}</option>{SYS_LEVELS.map((l) => <option key={l} value={l}>{t(`syslog.level_${l}`)}</option>)}</select></L>
        <L k="syslog.f_source"><input className="input mono" dir="ltr" list="syslog-sources" data-testid="syslog-source" placeholder={t('syslog.f_source_hint')} value={f.source} onChange={(e) => up({ source: e.target.value })} /><datalist id="syslog-sources">{SYS_SOURCES.map((s) => <option key={s} value={s} />)}</datalist></L>
        <L k="syslog.f_from"><input type="date" className="input" data-testid="syslog-from" value={f.from} onChange={(e) => up({ from: e.target.value })} /></L>
        <L k="syslog.f_to"><input type="date" className="input" data-testid="syslog-to" value={f.to} onChange={(e) => up({ to: e.target.value })} /></L>
      </div>
      <ActiveChips chips={chips} onClear={() => set(EMPTY_SYS_FILTER)} />
    </section>
  );
}

export function SystemLog() {
  const { t } = useTranslation();
  const toast = useToast();
  const me = useMe(true);
  const [f, setF] = useState<SysFilter>(EMPTY_SYS_FILTER);
  const q = useSystemLog(f);
  const tbl = useTablePrefs('system-log', DEFS);
  const [sel, setSel] = useState<SystemLogEntry | null>(null);
  const canExport = isAdmin(me.data) || hasGrant(me.data, 'export');
  const cell = (r: SystemLogEntry, c: string) => {
    switch (c) {
      case 'at': return <span className="mono text-xs" dir="ltr">{tripoliStamp(r.at)}</span>;
      case 'level': return <LevelChip level={r.level} testid={`syslog-level-${r.id}`} />;
      case 'source': return <span className="mono text-xs" dir="ltr">{r.source}</span>;
      case 'message': return <span dir="auto" title={r.message}>{r.message}</span>;
      case 'user': return r.user ? <Who a={r.user} /> : <span className="text-mute">{t('syslog.system')}</span>;
      case 'request': return <span className="mono text-xs" dir="ltr">{r.request_id ?? '—'}</span>;
      case 'route': return <span className="mono text-xs" dir="ltr">{r.route ?? '—'}</span>;
      default: return <span className="mono text-xs">{r.id}</span>;
    }
  };
  const doExport = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([systemLogCsv(q.items)], { type: 'text/csv;charset=utf-8' }));
    a.download = `system-log-${tripoliStamp(new Date().toISOString()).slice(0, 10)}.csv`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    toast(t('syslog.exported'));
  };
  return (
    <div data-testid="page-system-log">
      <PageHeader title={t('nav.logs.system')} subtitle={t('syslog.subtitle')} />
      <Toolbar
        filters={<SavedViews screen="system-log" value={f} onApply={setF} empty={EMPTY_SYS_FILTER} table={tbl} />}
        count={<span className="text-sm text-mute" data-testid="syslog-count">{t('syslog.shown', { count: q.items.length })}</span>}
        tools={<>
          <ColumnMenu api={tbl} label={(id) => t(`syslog.c_${id}`)} />
          {canExport && <button className="btn" data-testid="syslog-export" disabled={!q.items.length} onClick={doExport}><Download size={14} />{t('syslog.export')}</button>}
        </>} />
      <Filters f={f} set={setF} />
      <LogTable tbl={tbl} label={(id) => t(`syslog.c_${id}`)} rows={q.items} rowId={(r) => String(r.id)} cell={cell} onOpen={setSel} activeId={sel ? String(sel.id) : null} testid="syslog-table"
        loading={q.isLoading} error={q.isError} onRetry={() => void q.refetch()} hasMore={q.hasNextPage} onMore={() => void q.fetchNextPage()} loadingMore={q.isFetchingNextPage} />
      <DrawerFrame name="system-log" testid="syslog-drawer" open={!!sel} onClose={() => setSel(null)}>
        {sel && <Detail r={sel} onClose={() => setSel(null)} />}
      </DrawerFrame>
    </div>
  );
}

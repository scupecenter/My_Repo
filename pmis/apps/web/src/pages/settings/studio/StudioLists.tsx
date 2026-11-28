import { ArrowDown, ArrowUp, Check, Diamond, Pencil, RotateCcw, Save, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStudioBatch, type StudioBatch } from '@/api/workflowEditor';
import { useToast } from '@/components/Toast';
import { useErr } from '../wf/useErr';
import type { G, M, P } from '../wf/model';
import type { Ctx } from './studioCtx';

export type ListKind = 'tasks' | 'milestones' | 'gates';
type Edit = { name_en?: string; name_ar?: string; sla_min?: number; sla_max?: number; weight?: number };
type Pending = { tasks: Record<string, Edit>; milestones: Record<string, Edit>; gates: Record<string, Edit>; order: Record<string, string[]> };
const EMPTY: Pending = { tasks: {}, milestones: {}, gates: {}, order: {} };
type Sort = { key: string; dir: 1 | -1 };

const countOf = (p: Pending) => Object.values(p.tasks).reduce((n, e) => n + Object.keys(e).length, 0) + Object.values(p.milestones).reduce((n, e) => n + Object.keys(e).length, 0)
  + Object.values(p.gates).reduce((n, e) => n + Object.keys(e).length, 0) + Object.keys(p.order).length;

/** One cell of a list: shows the value, a click (or Enter) turns it into an input, Enter or leaving the cell keeps the change as an unsaved edit (amber), Escape cancels. */
function Cell({ value, saved, onSet, disabled, why, dir, number, testid, label, wide }: {
  value: string; saved: string; onSet: (v: string) => void; disabled: boolean; why?: string | null; dir?: 'ltr' | 'rtl'; number?: boolean; testid: string; label: string; wide?: boolean;
}) {
  const [on, setOn] = useState(false);
  const [text, setText] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (on) ref.current?.focus(); }, [on]);
  const dirty = value !== saved;
  const commit = () => { setOn(false); if (text.trim() !== value) onSet(text.trim()); };
  if (on) {
    return (
      <input ref={ref} className="input min-h-9 w-full px-2 py-1 text-sm" type={number ? 'number' : 'text'} min={number ? 0 : undefined} step={number ? 'any' : undefined} dir={dir} aria-label={label} data-testid={`${testid}-input`}
        value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } if (e.key === 'Escape') { setText(value); setOn(false); } }} />
    );
  }
  return (
    <button type="button" disabled={disabled} title={disabled ? why ?? undefined : label} aria-label={`${label}: ${value || '-'}`} data-testid={testid} data-dirty={dirty ? 'true' : undefined} dir={dir}
      onClick={() => { setText(value); setOn(true); }}
      className={`block min-h-9 w-full rounded-md border px-2 py-1 text-start text-sm disabled:cursor-not-allowed ${wide ? 'min-w-40' : ''} ${dirty ? 'border-waitInk bg-waitBg text-waitInk' : 'border-transparent hover:border-line hover:bg-hover'}`}>
      {value || <span className="text-mute">-</span>}
    </button>
  );
}

/**
 * Settings > Workflow Studio: three lists (tasks, milestones, gates) with search, filters and sort. The names (EN and AR), the SLA, the weight and the order are edited
 * in the table itself; an edit waits on the screen (amber) until "Save all" (one reason, then the server's own guards: step-up, If-Match, draft only, frozen days).
 * The pen of a row still opens the full form on the side for the complex fields (conditions, links, documents, columns). Leaving the page with edits waiting asks first.
 */
export function StudioLists({ c, kind, onKind, onOpen, onPending, version, query: q }: { c: Ctx; query: string; kind: ListKind; onKind: (k: ListKind) => void; onOpen: (kind: 'task' | 'milestone' | 'gate', code: string) => void; onPending: (n: number) => void; version: number }) {
  const { t } = useTranslation();
  const toast = useToast();
  const err = useErr();
  const batch = useStudioBatch(version, c.etag);
  const [pend, setPend] = useState<Pending>(EMPTY);
  const [ms, setMs] = useState('');
  const [status, setStatus] = useState<'active' | 'inactive' | 'all'>('active');
  const [onlyEdited, setOnlyEdited] = useState(false);
  const [sort, setSort] = useState<Sort>({ key: 'order', dir: 1 });
  const [failed, setFailed] = useState<string | null>(null);
  const n = countOf(pend);
  useEffect(() => { onPending(n); }, [n]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (n === 0) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [n]);

  const dis = !c.can.edit || c.can.busy;
  const why = c.can.why;
  const norm = (s: string) => s.toLowerCase();
  const match = (...f: (string | null | undefined)[]) => !q.trim() || f.some((x) => norm(x ?? '').includes(norm(q.trim())));
  const stat = (a: boolean | undefined) => status === 'all' || (status === 'active' ? a !== false : a === false);
  const msIdx = new Map(c.milestones.map((m, i) => [m.code, i]));
  const setEdit = (k: 'tasks' | 'milestones' | 'gates', code: string, field: keyof Edit, v: string | number | undefined, saved: string | number | undefined) => setPend((p) => {
    const cur = { ...(p[k][code] ?? {}) } as Record<string, string | number | undefined>;
    if (v === saved || v === undefined) delete cur[field]; else cur[field] = v;
    const next = { ...p[k] };
    if (Object.keys(cur).length) next[code] = cur as Edit; else delete next[code];
    return { ...p, [k]: next };
  });
  const val = <T extends string | number>(k: 'tasks' | 'milestones' | 'gates', code: string, field: keyof Edit, saved: T): T => ((pend[k][code] as Record<string, T> | undefined)?.[field] ?? saved);

  const orderOf = (stage: string): string[] => pend.order[stage] ?? c.placements.filter((p) => p.stage_code === stage).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)).map((p) => p.task_code);
  const move = (p: P, d: -1 | 1) => setPend((s) => {
    const list = [...orderOf(p.stage_code)]; const i = list.indexOf(p.task_code); const j = i + d;
    if (i < 0 || j < 0 || j >= list.length) return s;
    [list[i], list[j]] = [list[j]!, list[i]!];
    const base = c.placements.filter((x) => x.stage_code === p.stage_code).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)).map((x) => x.task_code);
    const order = { ...s.order };
    if (list.join('|') === base.join('|')) delete order[p.stage_code]; else order[p.stage_code] = list;
    return { ...s, order };
  });

  const taskRows = useMemo(() => {
    const rows = c.placements.filter((p) => stat(p.is_active) && (!ms || p.stage_code === ms) && match(p.task_code, p.name_en, p.name_ar) && (!onlyEdited || pend.tasks[p.task_code] || c.edited.has(p.task_code)));
    const pos = (p: P) => (pend.order[p.stage_code] ? pend.order[p.stage_code]!.indexOf(p.task_code) : p.sort_order ?? 0);
    const key = (p: P): string | number => {
      const it = c.sw.get(p.task_code);
      switch (sort.key) { case 'code': return p.task_code; case 'name': return p.name_en ?? ''; case 'ms': return msIdx.get(p.stage_code) ?? 0; case 'sla_min': return it?.sla?.min_working_days ?? -1; case 'sla_max': return it?.sla?.max_working_days ?? -1; case 'weight': return it?.counts_in_weight ? Number(it.weight_value) : -1; default: return (msIdx.get(p.stage_code) ?? 0) * 100000 + pos(p); }
    };
    return [...rows].sort((a, b) => { const x = key(a), y = key(b); return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * sort.dir; });
  }, [c.placements, c.sw, c.edited, q, ms, status, onlyEdited, sort, pend]); // eslint-disable-line react-hooks/exhaustive-deps
  const msRows = useMemo(() => c.milestones.filter((m) => stat(m.is_active) && match(m.code, m.name_en, m.name_ar) && (!onlyEdited || pend.milestones[m.code] || c.edited.has(m.code)))
    .sort((a, b) => (sort.key === 'name' ? a.name_en.localeCompare(b.name_en) * sort.dir : sort.key === 'code' ? a.code.localeCompare(b.code) * sort.dir : ((msIdx.get(a.code) ?? 0) - (msIdx.get(b.code) ?? 0)) * sort.dir)), [c.milestones, q, status, onlyEdited, sort, pend]); // eslint-disable-line react-hooks/exhaustive-deps
  const gateRows = useMemo(() => c.gates.filter((g) => stat(g.is_active) && (!ms || g.from_milestone === ms) && match(g.code, g.name_en, g.name_ar) && (!onlyEdited || pend.gates[g.code] || c.edited.has(g.code)))
    .sort((a, b) => (sort.key === 'name' ? a.name_en.localeCompare(b.name_en) * sort.dir : sort.key === 'code' ? a.code.localeCompare(b.code) * sort.dir : ((msIdx.get(a.from_milestone) ?? 0) - (msIdx.get(b.from_milestone) ?? 0)) * sort.dir)), [c.gates, q, ms, status, onlyEdited, sort, pend]); // eslint-disable-line react-hooks/exhaustive-deps

  const num = (s: string): number | undefined => (s.trim() !== '' && Number.isFinite(Number(s)) && Number(s) >= 0 ? Number(s) : undefined);
  const build = (reason: string): StudioBatch => {
    const tasks: StudioBatch['tasks'] = [];
    for (const [code, e] of Object.entries(pend.tasks)) {
      const it = c.sw.get(code);
      const row: StudioBatch['tasks'][number] = { code };
      if (e.name_en !== undefined || e.name_ar !== undefined) row.patch = { ...(e.name_en !== undefined ? { name_en: e.name_en } : {}), ...(e.name_ar !== undefined ? { name_ar: e.name_ar || null } : {}) };
      if ((e.sla_min !== undefined || e.sla_max !== undefined) && it?.sla) {
        const s = it.sla;
        row.sla = { min_working_days: e.sla_min ?? s.min_working_days, max_working_days: e.sla_max ?? s.max_working_days, start_event: s.start_event, unit: s.unit, calendar_code: s.calendar_code, warning_pct: s.warning_pct, breach_owner_role: s.breach_owner_role, escalation_role: s.escalation_role, pause_on_client_wait: s.pause_on_client_wait };
      }
      if (e.weight !== undefined && it) row.weight = { counts_in_weight: true, weight_value: e.weight, weight_group: it.weight_group };
      tasks.push(row);
    }
    const light = (m: Record<string, Edit>) => Object.entries(m).map(([code, e]) => ({ code, patch: { ...(e.name_en !== undefined ? { name_en: e.name_en } : {}), ...(e.name_ar !== undefined ? { name_ar: e.name_ar } : {}), ...(e.sla_min !== undefined ? { sla_min_wd: e.sla_min } : {}), ...(e.sla_max !== undefined ? { sla_max_wd: e.sla_max } : {}) } }));
    return { reason, tasks, milestones: light(pend.milestones), gates: light(pend.gates), order: Object.entries(pend.order).map(([stage, task_codes]) => ({ stage, task_codes })) };
  };
  const bad = (): string | null => {
    for (const [code, e] of Object.entries(pend.tasks)) { if (e.name_en !== undefined && !e.name_en.trim()) return code; const s = c.sw.get(code)?.sla; if (s && (e.sla_min ?? s.min_working_days) > (e.sla_max ?? s.max_working_days)) return code; }
    for (const [code, e] of Object.entries(pend.milestones)) if (e.name_en !== undefined && !e.name_en.trim()) return code;
    for (const [code, e] of Object.entries(pend.gates)) { if (e.name_en !== undefined && !e.name_en.trim()) return code; const g = c.gates.find((x) => x.code === code); if ((e.sla_min ?? g?.sla_min_wd ?? 0) > (e.sla_max ?? g?.sla_max_wd ?? Infinity)) return code; }
    return null;
  };
  const wrong = bad();
  const saveAll = () => c.askReason({
    title: t('studioLists.save_title', { count: n }), hint: t('studioLists.save_hint'),
    run: (reason, cb) => batch.mutate(build(reason), {
      onSuccess: () => { setPend(EMPTY); setFailed(null); cb.onSuccess(); },
      onError: (e) => { const done = (e as { done?: number }).done ?? 0; setFailed(t('studioLists.partial', { done })); toast(err(e)); cb.onError(e); },
    }),
  });

  const th = (key: string, label: string, cls = '') => (
    <th scope="col" aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'} className={`px-2 py-2 text-start font-semibold ${cls}`}>
      <button type="button" className="inline-flex items-center gap-1 hover:underline" data-testid={`studio-sort-${key}`} onClick={() => setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 }))}>
        {label}{sort.key === key && <span aria-hidden>{sort.dir === 1 ? '▲' : '▼'}</span>}
      </button>
    </th>
  );
  const pen = (k: 'task' | 'milestone' | 'gate', code: string) => (
    <button type="button" className="btn min-h-9 min-w-9 px-2" aria-label={t('studioLists.open_form', { code })} title={t('studioLists.open_form', { code })} data-testid={`studio-pen-${code}`} onClick={() => onOpen(k, code)}><Pencil size={14} aria-hidden /></button>
  );
  const tabs: ListKind[] = ['tasks', 'milestones', 'gates'];
  const total = { tasks: c.placements.filter((p) => p.is_active !== false).length, milestones: c.milestones.filter((m) => m.is_active !== false).length, gates: c.gates.filter((g) => g.is_active !== false).length };
  const names = (k: 'tasks' | 'milestones' | 'gates', code: string, en: string, ar: string | null | undefined) => (<>
    <td className="px-1 py-1"><Cell testid={`studio-en-${code}`} label={t('wfe.name_en')} dir="ltr" wide disabled={dis} why={why} saved={en} value={val(k, code, 'name_en', en)} onSet={(v) => setEdit(k, code, 'name_en', v, en)} /></td>
    <td className="px-1 py-1"><Cell testid={`studio-ar-${code}`} label={t('wfe.name_ar')} dir="rtl" wide disabled={dis} why={why} saved={ar ?? ''} value={val(k, code, 'name_ar', ar ?? '')} onSet={(v) => setEdit(k, code, 'name_ar', v, ar ?? '')} /></td>
  </>);
  const numCell = (k: 'tasks' | 'gates', code: string, field: 'sla_min' | 'sla_max' | 'weight', saved: number | undefined, label: string, off?: boolean) => (
    <td className="px-1 py-1"><Cell testid={`studio-${field}-${code}`} label={label} number dir="ltr" disabled={dis || !!off} why={off ? t('studioLists.no_rule') : why} saved={saved === undefined ? '' : String(saved)}
      value={String(val(k, code, field, saved ?? '') )} onSet={(v) => { const x = num(v); if (v === '') return; if (x !== undefined) setEdit(k, code, field, x, saved); }} /></td>
  );
  const msName = (code: string) => { const m = c.milestones.find((x) => x.code === code); return m ? c.nm(m) : code; };

  return (
    <section className="card space-y-3 rounded-xl p-3 sm:p-4" data-testid="studio-lists" aria-label={t('studioLists.title')}>
      <div role="tablist" aria-label={t('studioLists.title')} className="flex flex-wrap gap-1 border-b border-line">
        {tabs.map((k) => (
          <button key={k} role="tab" type="button" aria-selected={kind === k} data-testid={`studio-view-${k}`} onClick={() => { onKind(k); setSort({ key: 'order', dir: 1 }); }}
            className={`min-h-11 px-4 text-sm ${kind === k ? 'border-b-2 border-accent font-semibold' : 'text-mute hover:text-ink'}`}>{t(`studioLists.tab_${k}`)} <span className="text-xs text-mute" dir="ltr">{total[k]}</span></button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {kind !== 'milestones' && (
          <label className="text-sm"><span className="sr-only">{t('studio.milestone')}</span>
            <select className="input min-h-10 w-auto" data-testid="studio-filter-ms" value={ms} onChange={(e) => setMs(e.target.value)}>
              <option value="">{t('studioLists.all_ms')}</option>{c.milestones.map((m) => <option key={m.code} value={m.code}>{m.code} {c.nm(m)}</option>)}</select></label>
        )}
        <label className="text-sm"><span className="sr-only">{t('studioLists.status')}</span>
          <select className="input min-h-10 w-auto" data-testid="studio-filter-status" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="active">{t('studioLists.st_active')}</option><option value="inactive">{t('studioLists.st_inactive')}</option><option value="all">{t('studioLists.st_all')}</option></select></label>
        {c.isDraft && <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4" data-testid="studio-filter-edited" checked={onlyEdited} onChange={(e) => setOnlyEdited(e.target.checked)} />{t('studioLists.only_edited')}</label>}
      </div>

      {n > 0 && (
        <div role="status" className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-lg border border-waitInk bg-waitBg p-2 text-sm text-waitInk" data-testid="studio-unsaved">
          <span className="font-semibold" data-testid="studio-unsaved-count">{t('studioLists.unsaved', { count: n })}</span>
          {wrong && <span role="alert" className="text-lateInk" data-testid="studio-unsaved-bad">{t('studioLists.bad_row', { code: wrong })}</span>}
          {failed && <span role="alert" className="text-lateInk" data-testid="studio-unsaved-failed">{failed}</span>}
          <span className="ms-auto flex gap-2">
            <button type="button" className="btn min-h-9" data-testid="studio-unsaved-discard" disabled={batch.isPending} onClick={() => { setPend(EMPTY); setFailed(null); }}><RotateCcw size={14} aria-hidden />{t('studioLists.discard')}</button>
            <button type="button" className="btn btn-accent min-h-9" data-testid="studio-unsaved-save" disabled={dis || batch.isPending || !!wrong} onClick={saveAll}><Save size={14} aria-hidden />{t('studioLists.save_all')}</button>
          </span>
        </div>
      )}
      {!c.can.edit && <p className="text-sm text-mute" data-testid="studio-lists-readonly">{why}</p>}

      <div className="overflow-x-auto">
        {kind === 'tasks' && (
          <table className="w-full text-sm" data-testid="studio-table-tasks">
            <thead><tr className="border-b border-line bg-card2 text-mute">{th('order', t('studioLists.order'), 'w-24')}{th('code', t('studioLists.code'))}{th('ms', t('studio.milestone'))}{th('name', t('wfe.name_en'))}<th className="px-2 py-2 text-start font-semibold">{t('wfe.name_ar')}</th>{th('sla_min', t('wfe.sla_min'))}{th('sla_max', t('wfe.sla_max'))}{th('weight', t('studioLists.weight'))}<th className="w-12" /></tr></thead>
            <tbody>
              {taskRows.map((p) => {
                const it = c.sw.get(p.task_code);
                const list = orderOf(p.stage_code); const i = list.indexOf(p.task_code);
                const byOrder = sort.key === 'order' && sort.dir === 1 && !ms && !q;
                return (
                  <tr key={p.task_code} data-testid={`studio-trow-${p.task_code}`} className={`border-b border-line ${p.is_active === false ? 'opacity-60' : ''} ${c.edited.has(p.task_code) ? 'bg-waitBg/30' : ''}`}>
                    <td className="px-1 py-1">
                      <span className="flex items-center gap-1">
                        <button type="button" className="btn min-h-9 min-w-9 px-1" aria-label={t('studioLists.up', { code: p.task_code })} data-testid={`studio-up-${p.task_code}`} disabled={!c.can.struct || c.can.busy || !byOrder || i <= 0} title={!c.can.struct ? why ?? undefined : undefined} onClick={() => move(p, -1)}><ArrowUp size={14} aria-hidden /></button>
                        <button type="button" className="btn min-h-9 min-w-9 px-1" aria-label={t('studioLists.down', { code: p.task_code })} data-testid={`studio-down-${p.task_code}`} disabled={!c.can.struct || c.can.busy || !byOrder || i < 0 || i >= list.length - 1} title={!c.can.struct ? why ?? undefined : undefined} onClick={() => move(p, 1)}><ArrowDown size={14} aria-hidden /></button>
                      </span>
                    </td>
                    <td className="mono px-2 py-1 text-xs" dir="ltr">{p.task_code}</td>
                    <td className="px-2 py-1 text-xs text-mute"><span className="mono" dir="ltr">{p.stage_code}</span> {msName(p.stage_code)}</td>
                    {names('tasks', p.task_code, p.name_en ?? '', p.name_ar)}
                    {numCell('tasks', p.task_code, 'sla_min', it?.sla?.min_working_days, t('wfe.sla_min'), !it?.sla)}
                    {numCell('tasks', p.task_code, 'sla_max', it?.sla?.max_working_days, t('wfe.sla_max'), !it?.sla)}
                    {numCell('tasks', p.task_code, 'weight', it?.counts_in_weight ? Number(it.weight_value) : undefined, t('studioLists.weight'), !it?.counts_in_weight)}
                    <td className="px-1 py-1 text-end">{pen('task', p.task_code)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {kind === 'milestones' && (
          <table className="w-full text-sm" data-testid="studio-table-milestones">
            <thead><tr className="border-b border-line bg-card2 text-mute">{th('order', '#', 'w-12')}{th('code', t('studioLists.code'))}{th('name', t('wfe.name_en'))}<th className="px-2 py-2 text-start font-semibold">{t('wfe.name_ar')}</th><th className="px-2 py-2 text-start font-semibold">{t('studioLists.tasks_n')}</th><th className="w-12" /></tr></thead>
            <tbody>
              {msRows.map((m: M) => (
                <tr key={m.code} data-testid={`studio-mrow-${m.code}`} className={`border-b border-line ${m.is_active === false ? 'opacity-60' : ''} ${c.edited.has(m.code) ? 'bg-waitBg/30' : ''}`}>
                  <td className="px-2 py-1 text-xs text-mute" dir="ltr">{(msIdx.get(m.code) ?? 0) + 1}</td><td className="mono px-2 py-1 text-xs" dir="ltr">{m.code}</td>
                  {names('milestones', m.code, m.name_en, m.name_ar)}
                  <td className="px-2 py-1 text-xs text-mute" dir="ltr">{c.placements.filter((p) => p.stage_code === m.code && p.is_active !== false).length}</td>
                  <td className="px-1 py-1 text-end">{pen('milestone', m.code)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {kind === 'gates' && (
          <table className="w-full text-sm" data-testid="studio-table-gates">
            <thead><tr className="border-b border-line bg-card2 text-mute">{th('order', t('studioLists.after_ms'))}{th('code', t('studioLists.code'))}{th('name', t('wfe.name_en'))}<th className="px-2 py-2 text-start font-semibold">{t('wfe.name_ar')}</th><th className="px-2 py-2 text-start font-semibold">{t('wfe.sla_min')}</th><th className="px-2 py-2 text-start font-semibold">{t('wfe.sla_max')}</th><th className="px-2 py-2 text-start font-semibold">{t('wfe.conditions')}</th><th className="w-12" /></tr></thead>
            <tbody>
              {gateRows.map((g: G) => (
                <tr key={g.code} data-testid={`studio-grow-${g.code}`} className={`border-b border-line ${g.is_active === false ? 'opacity-60' : ''} ${c.edited.has(g.code) ? 'bg-waitBg/30' : ''}`}>
                  <td className="px-2 py-1 text-xs text-mute"><Diamond size={12} aria-hidden className="me-1 inline" /><span className="mono" dir="ltr">{g.from_milestone}</span> {msName(g.from_milestone)}</td><td className="mono px-2 py-1 text-xs" dir="ltr">{g.code}</td>
                  {names('gates', g.code, g.name_en, g.name_ar)}
                  {numCell('gates', g.code, 'sla_min', g.sla_min_wd ?? undefined, t('wfe.sla_min'))}
                  {numCell('gates', g.code, 'sla_max', g.sla_max_wd ?? undefined, t('wfe.sla_max'))}
                  <td className="px-2 py-1 text-xs text-mute"><span className="chip bg-hover text-ink" data-testid={`studio-gate-conds-${g.code}`}>{(g.conditions ?? []).length}</span></td>
                  <td className="px-1 py-1 text-end">{pen('gate', g.code)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {((kind === 'tasks' && !taskRows.length) || (kind === 'milestones' && !msRows.length) || (kind === 'gates' && !gateRows.length)) && <p className="p-6 text-center text-sm text-mute" data-testid="studio-list-empty">{t('studio.no_match')}</p>}
      </div>
      <p className="flex items-center gap-1 text-xs text-mute"><Check size={12} aria-hidden /><X size={12} aria-hidden className="hidden" />{t('studioLists.hint')}</p>
    </section>
  );
}

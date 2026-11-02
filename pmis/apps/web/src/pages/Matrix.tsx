import * as Dialog from '@radix-ui/react-dialog';
import * as Popover from '@radix-ui/react-popover';
import { Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/api/client';
import { useDeleteMatrixCell, useGroups, useMatrix, useMatrixOverrides, usePicker, usePublishMatrix, useRegions, useRoles } from '@/api/sites';
import type { Matrix as MatrixT, MatrixAssignee, MatrixCell, MatrixPatch } from '@/api/types';
import { HolderChip } from '@/components/HolderChip';
import { useToast } from '@/components/Toast';
import { L1_CELL, L2_CELL, levelCode, usedLevels } from '@/lib/matrixLevels';

type Row = MatrixT['stages'][number];
/** Two fixed levels (owner decision 2026-11-01): L1 Data Entry is cell level 1, L2 Data Reviewer & Approver is cell level 3. Cell level 2 is a leftover of the 3-level model and is not shown. */
const key = (code: string, level: number) => `${code}:${level}`;
/** The default cell of a level: the row default for every region (task and region cells come after it, but are not edited on this screen). */
const defaultCell = (cells: MatrixCell[], level: number) => cells.find((c) => c.level === level && !c.task_code && !c.region_id);

function AddHolder({ onAdd, onAddBoth, taken, otherLevel }: { onAdd: (a: MatrixAssignee) => void; onAddBoth: (a: MatrixAssignee) => void; taken: Set<string>; otherLevel: string }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const users = usePicker(q), roles = useRoles(), groups = useGroups();
  const ql = q.trim().toLowerCase();
  const opts: MatrixAssignee[] = [
    ...(users.data ?? []).map((u) => ({ kind: 'user' as const, ref_id: u.id, user_id: u.id, label: u.display_name, employee_id: u.employee_id })),
    ...(roles.data ?? []).filter((r) => r.can_hold_matrix_levels && r.name_en.toLowerCase().includes(ql)).map((r) => ({ kind: 'role' as const, ref_id: r.id, label: r.name_en })),
    ...(groups.data ?? []).filter((g) => g.name.toLowerCase().includes(ql)).map((g) => ({ kind: 'group' as const, ref_id: g.id, label: g.name })),
  ].filter((o) => !taken.has(o.ref_id));
  return (
    <Popover.Root>
      <Popover.Trigger asChild><button type="button" className="btn px-2 py-0.5 text-xs" aria-label={t('matrix.add')} data-testid="matrix-add"><Plus size={12} /></button></Popover.Trigger>
      <Popover.Portal>
        <Popover.Content sideOffset={6} className="card z-50 w-72 p-2" data-testid="matrix-picker">
          <input autoFocus className="input mb-2" data-testid="matrix-picker-q" placeholder={t('matrix.search')} aria-label={t('matrix.search')} value={q} onChange={(e) => setQ(e.target.value)} />
          <ul className="max-h-60 overflow-y-auto text-sm">
            {opts.map((o) => (
              <li key={o.ref_id} className="flex items-center gap-1">
                <button type="button" className="flex min-w-0 flex-1 items-center gap-2 rounded-md p-1.5 text-start hover:bg-hover" data-testid={`matrix-opt-${o.kind}-${o.employee_id ?? o.ref_id}`} onClick={() => onAdd(o)}>
                  <span className="chip bg-card2">{t(`holder.${o.kind}`)}</span>{o.label}{o.employee_id && <span className="mono text-xs text-mute">{o.employee_id}</span>}
                </button>
                {/* the explicit option of CLAUDE.md: grant L1 and L2 together to one holder (a submission is then the final approval, B5) */}
                <button type="button" className="btn px-1.5 py-0.5 text-xs" title={t('matrix.grant_both_hint')} aria-label={t('matrix.grant_both_for', { name: o.label })}
                  data-testid={`matrix-both-${o.kind}-${o.employee_id ?? o.ref_id}`} onClick={() => onAddBoth(o)}>{t('matrix.grant_both', { other: otherLevel })}</button>
              </li>
            ))}
            {!opts.length && <li className="p-2 text-mute">{t('matrix.no_options')}</li>}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Who sits in a cell: only people, only roles/groups, or a mix. */
const holderKind = (c: MatrixCell) => (c.assignees.every((a) => a.kind === 'user') ? 'user' : 'mixed');

function Cell({ row, level, cell, onChange, onBoth, refused }: { row: Row; level: number; cell?: MatrixCell; onChange: (c: MatrixCell) => void; onBoth: (a: MatrixAssignee) => void; refused?: boolean }) {
  const { t } = useTranslation();
  const base: MatrixCell = cell ?? { id: '', stage_code: row.code, task_code: null, level, region_id: null, rule: 'any_one', assignees: [] };
  const set = (p: Partial<MatrixCell>) => onChange({ ...base, ...p });
  const group = base.assignees.length > 1 || base.assignees.some((a) => a.kind !== 'user');
  return (
    <td className="p-2 align-top" data-testid={`matrix-cell-${row.code}-${level}`} data-level-code={levelCode(level)} data-refused={refused || undefined}>
      <div className={`flex min-h-12 flex-wrap items-start gap-1 rounded-md border border-dashed p-1.5 ${refused ? 'border-late bg-lateBg' : 'border-line'}`}>
        {base.assignees.map((a) => <HolderChip key={a.ref_id} a={a} onRemove={() => set({ assignees: base.assignees.filter((x) => x.ref_id !== a.ref_id) })} />)}
        <AddHolder taken={new Set(base.assignees.map((a) => a.ref_id))} onAdd={(a) => set({ assignees: [...base.assignees, a] })} onAddBoth={onBoth} otherLevel={t(`matrix.${level === L1_CELL ? 'l2_short' : 'l1_short'}`)} />
      </div>
      <div className="mt-1 text-xs text-mute" data-testid={`matrix-rule-${row.code}-${level}`} data-rule={base.rule} data-kind={holderKind(base)}>
        {t('matrixMore.rule')}: {t(`matrixMore.rule_${base.rule}`)}{base.assignees.length > 0 && holderKind(base) === 'mixed' ? ` · ${t('matrixMore.kind_mixed')}` : ''}
      </div>
      {(group || base.rule === 'all_members') && (
        <label className="mt-1 flex items-center gap-1 text-xs text-mute">
          <input type="checkbox" data-testid={`matrix-all-${row.code}-${level}`} checked={base.rule === 'all_members'} onChange={(e) => set({ rule: e.target.checked ? 'all_members' : 'any_one' })} />{t('matrix.all_members')}
        </label>
      )}
    </td>
  );
}

/** The region and task override cells of the matrix (Q86): listed read-only, each can be deleted with a reason (step-up); the row default then applies again. */
function Overrides() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const regions = useRegions();
  const [region, setRegion] = useState<number | null>(null);
  const q = useMatrixOverrides(region), del = useDeleteMatrixCell();
  const [target, setTarget] = useState<{ cell: MatrixCell; row: Row } | null>(null);
  const [why, setWhy] = useState('');
  const items = (q.data?.stages ?? []).flatMap((row) => row.cells.filter((c) => c.region_id || c.task_code).map((cell) => ({ row, cell })));
  const regionName = (id: number) => { const r = regions.data?.find((x) => x.id === id); return (i18n.language === 'ar' && r?.name_ar) || r?.name_en || String(id); };
  const confirm = () => {
    if (!target || !q.data) return;
    del.mutate({ version: q.data.version, cellId: target.cell.id, reason: why.trim() }, {
      onSuccess: () => { toast(t('matrix.override_deleted')); setTarget(null); setWhy(''); },
      onError: (e) => {
        setTarget(null);
        if (e instanceof ApiError && e.code === 'step_up_required') return; // the step-up dialog already said it
        toast(e instanceof ApiError && e.status === 403 ? t('errors.forbidden') : e instanceof ApiError && e.code === 'precondition_failed' ? t('errors.precondition_failed') : t('errors.generic'), 'err');
      },
    });
  };
  return (
    <section className="card mt-4 p-3" data-testid="matrix-overrides">
      <div className="mb-2 flex flex-wrap items-end gap-3">
        <div className="flex-1"><h3 className="font-bold">{t('matrix.overrides_title')}</h3><p className="text-sm text-mute">{t('matrix.overrides_hint')}</p></div>
        <label className="text-sm">{t('matrix.overrides_region')}{' '}
          <select className="input w-auto" data-testid="matrix-overrides-region" value={region ?? ''} onChange={(e) => setRegion(e.target.value ? Number(e.target.value) : null)}>
            <option value="">{t('matrix.overrides_tasks_only')}</option>
            {(regions.data ?? []).map((r) => <option key={r.id} value={r.id}>{(i18n.language === 'ar' && r.name_ar) || r.name_en}</option>)}
          </select>
        </label>
      </div>
      {items.length === 0 ? <p className="text-sm text-mute" data-testid="matrix-overrides-empty">{t('matrix.overrides_none')}</p> : (
        <ul className="divide-y divide-line text-sm">
          {items.map(({ row, cell }) => (
            <li key={cell.id} className="flex flex-wrap items-center gap-2 py-1.5" data-testid={`matrix-override-${cell.id}`}>
              <b>{(i18n.language === 'ar' && row.name_ar) || row.name_en}</b>
              <span className="chip bg-card2">{t(`matrix.${levelCode(cell.level) === 'L1' ? 'l1_short' : 'l2_short'}`)}</span>
              <span className="chip bg-card2">{cell.region_id ? t('matrix.override_region', { name: regionName(cell.region_id) }) : t('matrix.override_task', { code: cell.task_code })}</span>
              <span className="flex flex-wrap gap-1">{cell.assignees.map((a) => <HolderChip key={a.ref_id} a={a} />)}</span>
              <button type="button" className="btn ms-auto px-2 py-0.5 text-xs" data-testid={`matrix-override-delete-${cell.id}`} onClick={() => { setTarget({ cell, row }); setWhy(''); }}>{t('matrix.override_delete')}</button>
            </li>
          ))}
        </ul>
      )}
      <Dialog.Root open={!!target} onOpenChange={(o) => { if (!o) setTarget(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-scrim/60" />
          <Dialog.Content data-testid="matrix-override-dialog" className="card fixed inset-x-0 top-1/4 z-50 mx-auto w-[min(460px,92vw)] space-y-3 p-5">
            <Dialog.Title className="font-bold">{t('matrix.override_delete_title')}</Dialog.Title>
            <Dialog.Description className="text-sm text-mute">{t('matrix.override_delete_body')}</Dialog.Description>
            <label htmlFor="mx-del-reason" className="text-sm font-semibold">{t('matrix.reason')}</label>
            <textarea id="mx-del-reason" data-testid="matrix-override-reason" className="input min-h-20" value={why} onChange={(e) => setWhy(e.target.value)} />
            <div className="flex justify-end gap-2">
              <button className="btn" onClick={() => setTarget(null)}>{t('common.cancel')}</button>
              <button className="btn btn-primary" data-testid="matrix-override-confirm" disabled={why.trim().length < 3 || del.isPending} onClick={confirm}>{t('matrix.override_delete')}</button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}

export function MatrixPage() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const q = useMatrix(), publish = usePublishMatrix();
  const [cells, setCells] = useState<Record<string, MatrixCell>>({});
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const [refused, setRefused] = useState<string[]>([]);
  const [error, setError] = useState('');
  const m = q.data;
  const dirty = Object.keys(cells).length;

  const draft = useMemo<MatrixT | null>(() => (m ? {
    ...m, stages: m.stages.map((r) => {
      const cs = [...r.cells.map((c) => (!c.task_code && !c.region_id ? cells[key(r.code, c.level)] ?? c : c)), ...Object.values(cells).filter((c) => c.stage_code === r.code && !defaultCell(r.cells, c.level))];
      return { ...r, cells: cs };
    }),
  } : null), [m, cells]);

  /** Grants one holder L1 and L2 together: adds it to both default cells of the row, keeping what the draft already has. */
  const addBoth = (r: Row, a: MatrixAssignee) => setCells((x) => {
    const next = { ...x };
    for (const level of usedLevels()) {
      const cur = x[key(r.code, level)] ?? defaultCell(r.cells, level) ?? { id: '', stage_code: r.code, task_code: null, level, region_id: null, rule: 'any_one' as const, assignees: [] };
      if (!cur.assignees.some((h) => h.ref_id === a.ref_id)) next[key(r.code, level)] = { ...cur, assignees: [...cur.assignees, a] };
    }
    return next;
  });
  // Self-approval preview on the draft: someone holding L1 and L2 skips L2, and that is the final approval (B5, MX-06), recomputed live while editing.
  const skip = (r: Row) => {
    // an untouched row shows the server's own preview (`skip_preview` of the L1 cell); an edited row is recomputed live
    const touched = r.cells.some((c) => cells[key(r.code, c.level)]);
    const given = defaultCell(r.cells, L1_CELL)?.skip_preview;
    if (!touched && given) return given.map((u) => u.display_name);
    const next = defaultCell(r.cells, L2_CELL), cur = defaultCell(r.cells, L1_CELL);
    if (!next || !cur) return [];
    const ids = new Set(next.assignees.filter((a) => a.kind === 'user').map((a) => a.ref_id));
    return cur.assignees.filter((a) => a.kind === 'user' && ids.has(a.ref_id)).map((a) => a.label);
  };

  // B5: a person who holds L1 and L2 of a row approves their own submission. Shown before publishing, on the draft.
  const selfRows = (draft?.stages ?? []).map((r) => {
    const used = usedLevels().map((l) => defaultCell(r.cells, l));
    if (used.some((c) => !c)) return null;
    const sets = used.map((c) => new Map(c!.assignees.filter((a) => a.kind === 'user').map((a) => [a.ref_id, a.label])));
    const names = [...sets[0].entries()].filter(([id]) => sets.every((s) => s.has(id))).map(([, n]) => n);
    return names.length ? { row: r, names } : null;
  }).filter((x): x is { row: Row; names: string[] } => !!x);

  const send = () => {
    if (!m || !draft) return;
    const patch: MatrixPatch = {
      reason: reason.trim(),
      cells: Object.values(cells).map((c) => ({ stage_code: c.stage_code, task_code: null, level: c.level, region_id: null, rule: c.rule, assignees: c.assignees.map((a) => ({ kind: a.kind, ref_id: a.ref_id })) })),
    };
    publish.mutate({ matrix: m, patch, draft }, {
      onSuccess: () => { toast(t('matrix.published')); setCells({}); setAsking(false); setReason(''); setRefused([]); setError(''); },
      onError: (e) => {
        setAsking(false);
        if (e instanceof ApiError && e.code === 'step_up_required') return; // the step-up dialog already said it
        // empty_cell (422): `Problem.cells` lists the levels in use that have no holder (stage_code = the row, level = cell level); keep the edits so they can be fixed
        const bad = e instanceof ApiError && e.code === 'empty_cell' ? (e.problem.cells ?? []).filter((x) => !x.task_code && !x.region_id) : [];
        setRefused(bad.map((c) => key(c.stage_code, c.level)));
        const names = bad.map((c) => t('matrixMore.empty_cell_one', { name: (m?.stages.find((r) => r.code === c.stage_code)?.name_en ?? c.stage_code), level: t(`matrix.${levelCode(c.level) === 'L1' ? 'l1_short' : 'l2_short'}`) }));
        const msg = e instanceof ApiError && e.code === 'empty_cell' ? (names.join(' ') || t('matrix.empty_cell')) : e instanceof ApiError && e.code === 'precondition_failed' ? t('errors.precondition_failed') : e instanceof ApiError && e.status === 403 ? t('errors.forbidden') : t('errors.generic');
        setError(msg); toast(msg, 'err');
      },
    });
  };

  const groups: { id: string; rows: Row[] }[] = draft ? [
    { id: 'stage', rows: draft.stages.filter((r) => (r.kind ?? 'stage') === 'stage') },
    { id: 'register', rows: draft.stages.filter((r) => r.kind === 'register') },
    { id: 'dismantle', rows: draft.stages.filter((r) => r.kind === 'dismantle') },
  ] : [];

  return (
    <div data-testid="page-matrix">
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <div className="flex-1"><h2 className="text-lg font-bold">{t('matrix.title')}</h2><p className="text-mute">{t('matrix.subtitle')}</p></div>
        <span className="text-sm text-mute" data-testid="matrix-dirty">{t('matrix.changes', { count: dirty })}</span>
        <button className="btn" disabled={!dirty} data-testid="matrix-discard" onClick={() => { setCells({}); setRefused([]); setError(''); }}>{t('matrix.discard')}</button>
        <button className="btn btn-primary" disabled={!dirty || publish.isPending} data-testid="matrix-publish" onClick={() => setAsking(true)}>{t('matrix.publish')}</button>
      </div>
      {error && <p role="alert" data-testid="matrix-error" className="mb-3 rounded-md bg-lateBg p-3 text-lateInk">{t('matrixMore.refused')} {error}</p>}
      {selfRows.length > 0 && (
        <div className="mb-3 rounded-md bg-waitBg p-3 text-sm text-waitInk" data-testid="matrix-warnings">
          <b>{t('matrixMore.warn_title')}</b>
          <ul className="mt-1 list-disc ps-5">
            {selfRows.map((x) => <li key={x.row.code} data-testid={`matrix-warn-self-${x.row.code}`}>{t('matrixMore.self_approval_row', { names: x.names.join(', '), row: x.row.name_en })}</li>)}
          </ul>
        </div>
      )}
      <div className="card overflow-x-auto">
        <table className="w-full min-w-[960px] text-sm" data-testid="matrix-table">
          <thead className="bg-card2 text-start text-mute"><tr>{['stage', 'l1', 'l2', 'skip'].map((c) => <th key={c} className="p-2 text-start" data-testid={`matrix-col-${c}`}>{t(`matrix.col_${c}`)}</th>)}</tr></thead>
          <tbody>
            {groups.map((g) => g.rows.length > 0 && [
              <tr key={`h-${g.id}`}><th colSpan={4} className="bg-card2 p-2 text-start text-xs uppercase text-mute" data-testid={`matrix-group-${g.id}`}>{t(`matrix.group_${g.id}`)}</th></tr>,
              ...g.rows.map((r) => {
                // L1 and L2 only: a person who holds both takes the final decision on their own submission
                const who = skip(r);
                return (
                  <tr key={r.code} className="border-t border-line" data-testid={`matrix-row-${r.code}`}>
                    <td className="p-2 align-top font-semibold">{(i18n.language === 'ar' && r.name_ar) || r.name_en}</td>
                    {usedLevels().map((level) => (
                      <Cell key={level} row={r} level={level} refused={refused.includes(key(r.code, level))} cell={defaultCell(r.cells, level)} onBoth={(a) => addBoth(r, a)}
                        onChange={(c) => setCells((x) => ({ ...x, [key(r.code, level)]: c }))} />
                    ))}
                    <td className="p-2 align-top text-xs text-mute" data-testid={`matrix-skip-${r.code}`}>
                      {who.length ? <div className="text-waitInk">{t('matrix.skip_line', { names: who.join(', ') })} {t('matrix.self_approval')}</div> : '—'}
                    </td>
                  </tr>
                );
              }),
            ])}
          </tbody>
        </table>
        {q.isLoading && <p className="p-4 text-mute">{t('common.loading')}</p>}
      </div>
      <Overrides />
      <Dialog.Root open={asking} onOpenChange={setAsking}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-scrim/60" />
          <Dialog.Content data-testid="matrix-publish-dialog" className="card fixed inset-x-0 top-1/4 z-50 mx-auto w-[min(460px,92vw)] space-y-3 p-5">
            <Dialog.Title className="font-bold">{t('matrix.publish_title')}</Dialog.Title>
            <Dialog.Description className="text-sm text-mute">{t('matrix.publish_body')}</Dialog.Description>
            <label htmlFor="mx-reason" className="text-sm font-semibold">{t('matrix.reason')}</label>
            <textarea id="mx-reason" data-testid="matrix-reason" className="input min-h-20" value={reason} onChange={(e) => setReason(e.target.value)} />
            <div className="flex justify-end gap-2">
              <button className="btn" onClick={() => setAsking(false)}>{t('common.cancel')}</button>
              <button className="btn btn-primary" data-testid="matrix-publish-confirm" disabled={reason.trim().length < 3 || publish.isPending} onClick={send}>{t('matrix.publish')}</button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

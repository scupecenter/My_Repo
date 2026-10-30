import * as Dialog from '@radix-ui/react-dialog';
import * as Popover from '@radix-ui/react-popover';
import { Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/api/client';
import { useGroups, useMatrix, usePicker, usePublishMatrix, useRoles } from '@/api/sites';
import type { Matrix as MatrixT, MatrixAssignee, MatrixCell, MatrixPatch } from '@/api/types';
import { HolderChip } from '@/components/HolderChip';
import { useToast } from '@/components/Toast';

type Row = MatrixT['stages'][number];
const LEVEL_KIND = (level: number, n: number) => (level === 1 ? 'entry' : level === n ? 'approve' : 'review');
const key = (code: string, level: number) => `${code}:${level}`;

function AddHolder({ onAdd, taken }: { onAdd: (a: MatrixAssignee) => void; taken: Set<string> }) {
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
              <li key={o.ref_id}><button type="button" className="flex w-full items-center gap-2 rounded-md p-1.5 text-start hover:bg-hover" data-testid={`matrix-opt-${o.kind}-${o.employee_id ?? o.ref_id}`} onClick={() => onAdd(o)}>
                <span className="chip bg-card2">{t(`holder.${o.kind}`)}</span>{o.label}{o.employee_id && <span className="mono text-xs text-mute">{o.employee_id}</span>}
              </button></li>
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

function Cell({ row, level, cell, onChange, refused }: { row: Row; level: number; cell?: MatrixCell; onChange: (c: MatrixCell) => void; refused?: boolean }) {
  const { t } = useTranslation();
  const base: MatrixCell = cell ?? { id: '', stage_code: row.code, task_code: null, level, region_id: null, rule: 'any_one', assignees: [] };
  const set = (p: Partial<MatrixCell>) => onChange({ ...base, ...p });
  const group = base.assignees.length > 1 || base.assignees.some((a) => a.kind !== 'user');
  return (
    <td className="p-2 align-top" data-testid={`matrix-cell-${row.code}-${level}`} data-refused={refused || undefined}>
      <div className={`flex min-h-12 flex-wrap items-start gap-1 rounded-md border border-dashed p-1.5 ${refused ? 'border-late bg-lateBg' : 'border-line'}`}>
        {base.assignees.map((a) => <HolderChip key={a.ref_id} a={a} onRemove={() => set({ assignees: base.assignees.filter((x) => x.ref_id !== a.ref_id) })} />)}
        <AddHolder taken={new Set(base.assignees.map((a) => a.ref_id))} onAdd={(a) => set({ assignees: [...base.assignees, a] })} />
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

export function MatrixPage() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const q = useMatrix(), publish = usePublishMatrix();
  const [cells, setCells] = useState<Record<string, MatrixCell>>({});
  const [levels, setLevels] = useState<Record<string, number>>({});
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const [refused, setRefused] = useState<string[]>([]);
  const [error, setError] = useState('');
  const m = q.data;
  const dirty = Object.keys(cells).length + Object.keys(levels).length;

  const draft = useMemo<MatrixT | null>(() => (m ? {
    ...m, stages: m.stages.map((r) => {
      const n = levels[r.code] ?? r.approval_levels;
      const cs = [...r.cells.map((c) => cells[key(r.code, c.level)] ?? c), ...Object.values(cells).filter((c) => c.stage_code === r.code && !r.cells.some((x) => x.level === c.level))];
      return { ...r, approval_levels: n, cells: cs };
    }),
  } : null), [m, cells, levels]);
  // Skip preview on the draft: someone holding level L and L+1 skips L+1 (MX-06), recomputed live while editing.
  const skip = (r: Row, level: number) => {
    // an untouched row shows the server's own preview (`skip_preview` of the cell); an edited row is recomputed live
    const touched = r.cells.some((c) => cells[key(r.code, c.level)]) || levels[r.code] !== undefined;
    const given = r.cells.find((c) => c.level === level)?.skip_preview;
    if (!touched && given) return given.map((u) => u.display_name);
    const next = r.cells.find((c) => c.level === level + 1), cur = r.cells.find((c) => c.level === level);
    if (!next || !cur || level >= r.approval_levels) return [];
    const ids = new Set(next.assignees.filter((a) => a.kind === 'user').map((a) => a.ref_id));
    return cur.assignees.filter((a) => a.kind === 'user' && ids.has(a.ref_id)).map((a) => a.label);
  };

  // B5: a person who holds every used level of a row approves their own submission. Shown before publishing, on the draft.
  const selfRows = (draft?.stages ?? []).map((r) => {
    const used = Array.from({ length: r.approval_levels }, (_, i) => r.cells.find((c) => c.level === i + 1));
    if (used.some((c) => !c)) return null;
    const sets = used.map((c) => new Map(c!.assignees.filter((a) => a.kind === 'user').map((a) => [a.ref_id, a.label])));
    const names = [...sets[0].entries()].filter(([id]) => sets.every((s) => s.has(id))).map(([, n]) => n);
    return names.length ? { row: r, names } : null;
  }).filter((x): x is { row: Row; names: string[] } => !!x);

  const send = () => {
    if (!m || !draft) return;
    const patch: MatrixPatch = {
      reason: reason.trim(),
      stage_levels: Object.entries(levels).map(([stage_code, approval_levels]) => ({ stage_code, approval_levels })),
      cells: Object.values(cells).map((c) => ({ stage_code: c.stage_code, task_code: null, level: c.level, region_id: null, rule: c.rule, assignees: c.assignees.map((a) => ({ kind: a.kind, ref_id: a.ref_id })) })),
    };
    if (!patch.stage_levels?.length) delete patch.stage_levels;
    publish.mutate({ matrix: m, patch, draft }, {
      onSuccess: () => { toast(t('matrix.published')); setCells({}); setLevels({}); setAsking(false); setReason(''); setRefused([]); setError(''); },
      onError: (e) => {
        setAsking(false);
        if (e instanceof ApiError && e.code === 'step_up_required') return; // the step-up dialog already said it
        // empty_cell: say which levels have no holder (`errors[].path` = /cells/<stage>/<level>), keep the edits so they can be fixed
        const bad = e instanceof ApiError ? (e.problem.errors ?? []).filter((x) => x.code === 'empty_cell').map((x) => x.path.split('/').slice(-2)) : [];
        setRefused(bad.map(([s, l]) => key(s, Number(l))));
        const names = bad.map(([s, l]) => t('matrixMore.empty_cell_one', { name: (m?.stages.find((r) => r.code === s)?.name_en ?? s), level: l }));
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
        <button className="btn" disabled={!dirty} data-testid="matrix-discard" onClick={() => { setCells({}); setLevels({}); setRefused([]); setError(''); }}>{t('matrix.discard')}</button>
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
          <thead className="bg-card2 text-start text-mute"><tr>{['stage', 'levels', 'entry', 'review', 'approve', 'skip'].map((c) => <th key={c} className="p-2 text-start">{t(`matrix.col_${c}`)}</th>)}</tr></thead>
          <tbody>
            {groups.map((g) => g.rows.length > 0 && [
              <tr key={`h-${g.id}`}><th colSpan={6} className="bg-card2 p-2 text-start text-xs uppercase text-mute" data-testid={`matrix-group-${g.id}`}>{t(`matrix.group_${g.id}`)}</th></tr>,
              ...g.rows.map((r) => {
                const n = r.approval_levels;
                const skips = [1, 2].map((l) => ({ l, who: skip(r, l) })).filter((x) => x.who.length);
                return (
                  <tr key={r.code} className="border-t border-line" data-testid={`matrix-row-${r.code}`}>
                    <td className="p-2 align-top font-semibold">{(i18n.language === 'ar' && r.name_ar) || r.name_en}</td>
                    <td className="p-2 align-top">
                      <select className="input w-auto" aria-label={t('matrix.levels_of', { name: r.name_en })} data-testid={`matrix-levels-${r.code}`} value={n} onChange={(e) => setLevels((x) => ({ ...x, [r.code]: Number(e.target.value) }))}>
                        {[1, 2, 3].map((v) => <option key={v} value={v}>{t('matrix.levels', { count: v })}</option>)}
                      </select>
                    </td>
                    {[1, 2, 3].map((slot) => {
                      // Entry is level 1, approve is the last level, review sits between; unused columns stay empty.
                      const level = slot === 1 ? 1 : slot === 3 ? n : 2;
                      const used = slot === 1 || (slot === 3 && n > 1) || (slot === 2 && n === 3);
                      return used
                        ? <Cell key={slot} row={r} level={level} refused={refused.includes(key(r.code, level))} cell={r.cells.find((c) => c.level === level)} onChange={(c) => setCells((x) => ({ ...x, [key(r.code, level)]: c }))} />
                        : <td key={slot} className="p-2 text-mute">—</td>;
                    })}
                    <td className="p-2 align-top text-xs text-mute" data-testid={`matrix-skip-${r.code}`}>
                      {skips.length ? skips.map((x) => <div key={x.l}>{t('matrix.skip_line', { from: t(`level.${LEVEL_KIND(x.l, n)}`), to: t(`level.${LEVEL_KIND(x.l + 1, n)}`), names: x.who.join(', ') })}</div>) : '—'}
                      {n === 1 && <div className="text-waitInk">{t('matrix.self_approval')}</div>}
                    </td>
                  </tr>
                );
              }),
            ])}
          </tbody>
        </table>
        {q.isLoading && <p className="p-4 text-mute">{t('common.loading')}</p>}
      </div>
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

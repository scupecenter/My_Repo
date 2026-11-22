import type { SlaWeightItem } from '@/api/workflowEditor';
import { diffVersions, type G, type M, type P } from '../wf/model';

/** What the Studio has selected: a task, a gate or a milestone of the shown version. */
export type StudioSel = { kind: 'task' | 'gate' | 'milestone'; code: string } | null;
export type Struct = { milestones: M[]; gates: G[]; placements: P[] };

export type ChangeKey =
  | 'ms_added' | 'ms_removed' | 'ms_renamed' | 'ms_reordered' | 'g_added' | 'g_removed' | 'g_changed'
  | 't_added' | 't_deactivated' | 't_moved' | 't_renamed' | 't_relinked' | 't_closing' | 'sla_changed' | 'weight_changed';
export type Change = { id: string; key: ChangeKey; kind: 'light' | 'structural'; area: 'milestone' | 'gate' | 'task' | 'sla' | 'weight'; code: string; detail: string };

/** Structural changes make a new version of the flow for sites; the rest are light edits (names, conditions, SLA, weight). */
const STRUCTURAL: ReadonlySet<ChangeKey> = new Set(['ms_added', 'ms_removed', 'ms_reordered', 'g_added', 'g_removed', 't_added', 't_deactivated', 't_moved', 't_relinked', 't_closing']);
const AREA: Record<ChangeKey, Change['area']> = {
  ms_added: 'milestone', ms_removed: 'milestone', ms_renamed: 'milestone', ms_reordered: 'milestone', g_added: 'gate', g_removed: 'gate', g_changed: 'gate',
  t_added: 'task', t_deactivated: 'task', t_moved: 'task', t_renamed: 'task', t_relinked: 'task', t_closing: 'task', sla_changed: 'sla', weight_changed: 'weight',
};

const sla = (x?: SlaWeightItem) => (x?.sla ? `${x.sla.min_working_days}/${x.sla.max_working_days}` : '-');
const wt = (x?: SlaWeightItem) => (x?.counts_in_weight ? `${x.weight_value}% ${x.weight_group ?? ''}`.trim() : '-');

/** The list of changes of a draft against its parent version, built from the two versions the API returns (no separate changes endpoint exists). */
export function pendingChanges(parent: Struct, draft: Struct, parentSw: SlaWeightItem[] = [], draftSw: SlaWeightItem[] = []): Change[] {
  const d = diffVersions(parent, draft);
  const pt = new Map(parent.placements.map((p) => [p.task_code, p])), dt = new Map(draft.placements.map((p) => [p.task_code, p]));
  const pm = new Map(parent.milestones.map((m) => [m.code, m])), dm = new Map(draft.milestones.map((m) => [m.code, m]));
  const out: Change[] = [];
  const add = (key: ChangeKey, code: string, detail = '') => out.push({ id: `${key}:${code}`, key, kind: STRUCTURAL.has(key) ? 'structural' : 'light', area: AREA[key], code, detail });
  d.milestones.added.forEach((c) => add('ms_added', c, dm.get(c)?.name_en ?? ''));
  d.milestones.removed.forEach((c) => add('ms_removed', c, pm.get(c)?.name_en ?? ''));
  d.milestones.renamed.forEach((c) => add('ms_renamed', c, `${pm.get(c)?.name_en ?? ''} → ${dm.get(c)?.name_en ?? ''}`));
  if (d.milestones.reordered) add('ms_reordered', '*');
  d.gates.added.forEach((c) => add('g_added', c, draft.gates.find((g) => g.code === c)?.name_en ?? ''));
  d.gates.removed.forEach((c) => add('g_removed', c, parent.gates.find((g) => g.code === c)?.name_en ?? ''));
  d.gates.changed.forEach((c) => add('g_changed', c, draft.gates.find((g) => g.code === c)?.name_en ?? ''));
  d.tasks.added.forEach((c) => add('t_added', c, dt.get(c)?.name_en ?? ''));
  d.tasks.deactivated.forEach((c) => add('t_deactivated', c, pt.get(c)?.name_en ?? ''));
  d.tasks.moved.forEach((c) => add('t_moved', c, `${pt.get(c)?.stage_code ?? ''} → ${dt.get(c)?.stage_code ?? ''}`));
  d.tasks.renamed.forEach((c) => add('t_renamed', c, `${pt.get(c)?.name_en ?? ''} → ${dt.get(c)?.name_en ?? ''}`));
  d.tasks.relinked.forEach((c) => add('t_relinked', c, `${(pt.get(c)?.predecessors ?? []).join(', ') || '-'} → ${(dt.get(c)?.predecessors ?? []).join(', ') || '-'}`));
  d.tasks.closing.forEach((c) => add('t_closing', c, dt.get(c)?.name_en ?? ''));
  const ps = new Map(parentSw.map((x) => [x.task_code, x])), ds = new Map(draftSw.map((x) => [x.task_code, x]));
  for (const [c, x] of ds) {
    if (!pt.has(c)) continue;
    if (sla(ps.get(c)) !== sla(x) || ps.get(c)?.sla?.start_event !== x.sla?.start_event) add('sla_changed', c, `${sla(ps.get(c))} → ${sla(x)}`);
    if (wt(ps.get(c)) !== wt(x)) add('weight_changed', c, `${wt(ps.get(c))} → ${wt(x)}`);
  }
  return out;
}

/** Codes that carry the amber dot in the tree. */
export const editedCodes = (changes: Change[]): Set<string> => new Set(changes.map((c) => c.code).filter((c) => c !== '*'));

/** The Site Master column a milestone or a gate writes (null when the version carries none). */
export const masterCol = (x: object | undefined): string | null => (x as { master_export_column?: string | null } | undefined)?.master_export_column ?? null;

export type TreeRow = { m: M; tasks: P[]; gate: G | undefined; open: boolean };

/** The tree of the shown version, filtered by a search on code, name (EN or AR) or Master column. A hit opens its milestone; a milestone that matches shows all its tasks. */
export function buildTree(s: Struct, query: string, expanded: ReadonlySet<string>): TreeRow[] {
  const q = query.trim().toLowerCase();
  const hit = (...v: (string | null | undefined)[]) => v.some((x) => (x ?? '').toLowerCase().includes(q));
  return s.milestones.flatMap((m) => {
    const all = s.placements.filter((p) => p.stage_code === m.code).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    const gate = s.gates.find((g) => g.from_milestone === m.code && g.is_active !== false);
    if (!q) return [{ m, tasks: all, gate, open: expanded.has(m.code) }];
    const mHit = hit(m.code, m.name_en, m.name_ar, masterCol(m));
    const tasks = mHit ? all : all.filter((p) => hit(p.task_code, p.name_en, p.name_ar));
    const gHit = !!gate && hit(gate.code, gate.name_en, gate.name_ar, masterCol(gate));
    return mHit || tasks.length > 0 || gHit ? [{ m, tasks, gate: !mHit && !gHit ? undefined : gate, open: true }] : [];
  });
}

/** The next active milestone after `code`, the one a gate after `code` leads to. */
export const nextMilestone = (milestones: M[], code: string): M | undefined => milestones.slice(milestones.findIndex((m) => m.code === code) + 1).find((m) => m.is_active !== false);

import type { GateCondition, MigrationPreview, SlaWeightItem, SlaRuleInput, StructureInput } from '@/api/workflowEditor';
import { diffVersions, type G, type M, type P } from '../wf/model';

/** What the Studio has selected: a task, a gate or a milestone of the shown version. */
export type StudioSel = { kind: 'task' | 'gate' | 'milestone'; code: string } | null;
export type Struct = { milestones: M[]; gates: G[]; placements: P[] };

export type ChangeKey =
  | 'ms_added' | 'ms_removed' | 'ms_renamed' | 'ms_reordered' | 'g_added' | 'g_removed' | 'g_changed'
  | 't_added' | 't_deactivated' | 't_moved' | 't_renamed' | 't_relinked' | 't_closing' | 'sla_changed' | 'weight_changed';
/** `detail` is the text of the change ("old -> new"); `from` and `to` are its two ends when it has two, and `ltr` says they are codes or numbers (kept left to right) rather than names. */
export type Change = { id: string; key: ChangeKey; kind: 'light' | 'structural'; area: 'milestone' | 'gate' | 'task' | 'sla' | 'weight'; code: string; detail: string; from?: string; to?: string; ltr?: boolean };

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
  const add = (key: ChangeKey, code: string, detail = '', ends?: { from: string; to: string; ltr?: boolean }) => out.push({ id: `${key}:${code}`, key, kind: STRUCTURAL.has(key) ? 'structural' : 'light', area: AREA[key], code, detail, ...(ends ?? {}) });
  const flow = (from: string, to: string, ltr = false) => ({ detail: `${from} → ${to}`, ends: { from, to, ltr } });
  d.milestones.added.forEach((c) => add('ms_added', c, dm.get(c)?.name_en ?? ''));
  d.milestones.removed.forEach((c) => add('ms_removed', c, pm.get(c)?.name_en ?? ''));
  d.milestones.renamed.forEach((c) => { const f = flow(pm.get(c)?.name_en ?? '', dm.get(c)?.name_en ?? ''); add('ms_renamed', c, f.detail, f.ends); });
  if (d.milestones.reordered) add('ms_reordered', '*');
  d.gates.added.forEach((c) => add('g_added', c, draft.gates.find((g) => g.code === c)?.name_en ?? ''));
  d.gates.removed.forEach((c) => add('g_removed', c, parent.gates.find((g) => g.code === c)?.name_en ?? ''));
  d.gates.changed.forEach((c) => add('g_changed', c, draft.gates.find((g) => g.code === c)?.name_en ?? ''));
  d.tasks.added.forEach((c) => add('t_added', c, dt.get(c)?.name_en ?? ''));
  d.tasks.deactivated.forEach((c) => add('t_deactivated', c, pt.get(c)?.name_en ?? ''));
  d.tasks.moved.forEach((c) => { const f = flow(pt.get(c)?.stage_code ?? '', dt.get(c)?.stage_code ?? '', true); add('t_moved', c, f.detail, f.ends); });
  d.tasks.renamed.forEach((c) => { const f = flow(pt.get(c)?.name_en ?? '', dt.get(c)?.name_en ?? ''); add('t_renamed', c, f.detail, f.ends); });
  d.tasks.relinked.forEach((c) => { const f = flow((pt.get(c)?.predecessors ?? []).join(', ') || '-', (dt.get(c)?.predecessors ?? []).join(', ') || '-', true); add('t_relinked', c, f.detail, f.ends); });
  d.tasks.closing.forEach((c) => add('t_closing', c, dt.get(c)?.name_en ?? ''));
  const ps = new Map(parentSw.map((x) => [x.task_code, x])), ds = new Map(draftSw.map((x) => [x.task_code, x]));
  for (const [c, x] of ds) {
    if (!pt.has(c)) continue;
    if (sla(ps.get(c)) !== sla(x) || ps.get(c)?.sla?.start_event !== x.sla?.start_event) { const f = flow(sla(ps.get(c)), sla(x), true); add('sla_changed', c, f.detail, f.ends); }
    if (wt(ps.get(c)) !== wt(x)) { const f = flow(wt(ps.get(c)), wt(x), true); add('weight_changed', c, f.detail, f.ends); }
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

/** One write that puts the parent version's value back, through the door the Studio already uses for that kind of edit. */
export type UndoOp =
  | { door: 'msLight'; body: { code: string; name_en: string; name_ar: string } }
  | { door: 'gateLight'; body: { code: string; name_en: string; name_ar: string; sla_min_wd?: number; sla_max_wd?: number; conditions: GateCondition[] } }
  | { door: 'updateTask'; body: { code: string; name_en?: string; name_ar?: string | null; is_active?: boolean; stage_code?: string } }
  | { door: 'setPreds'; body: { code: string; predecessors: string[] } }
  | { door: 'setClosing'; body: { code: string; closing: boolean } }
  | { door: 'saveSla'; body: Omit<SlaRuleInput, 'reason'> & { code: string } }
  | { door: 'removeSla'; body: { code: string; rule: string } }
  | { door: 'setWeight'; body: { code: string; counts_in_weight: boolean; weight_value?: number; weight_group?: string | null } }
  | { door: 'removeItem'; body: { kind: 'task' | 'milestone' | 'gate'; code: string } }
  | { door: 'replace'; body: Omit<StructureInput, 'reason'> };
/** Why an undo cannot be done through the API: a translation key under `studioPanel.undo_no_*`. */
export type UndoPlan = { ok: true; op: UndoOp; needsStruct: boolean; hint: string } | { ok: false; why: 'removed' | 'gate_ends' | 'clear_sla' | 'link_gone' | 'stage_gone' };

type Sw = SlaWeightItem | undefined;
/** The write that undoes one change of the draft, worked out from the parent version and the draft. `hint` is the translation key of what will be put back. */
export function undoPlan(ch: Change, parent: Struct, draft: Struct, parentSw: Sw[] = [], draftSw: Sw[] = []): UndoPlan {
  const pm = parent.milestones.find((m) => m.code === ch.code), dm = draft.milestones.find((m) => m.code === ch.code);
  const pg = parent.gates.find((g) => g.code === ch.code), dg = draft.gates.find((g) => g.code === ch.code);
  const pt = parent.placements.find((p) => p.task_code === ch.code);
  const ps = parentSw.find((x) => x?.task_code === ch.code), ds = draftSw.find((x) => x?.task_code === ch.code);
  const msList = (over: (m: M) => Partial<StructureInput['milestones'][number]> = () => ({}), order?: string[]) => {
    const rows = draft.milestones.map((m) => ({ code: m.code, is_active: m.is_active !== false, ...over(m) }));
    return order ? [...order.map((c) => rows.find((r) => r.code === c)).filter((r): r is (typeof rows)[number] => !!r), ...rows.filter((r) => !order.includes(r.code))] : rows;
  };
  const gList = (over: (g: G) => Partial<StructureInput['gates'][number]> = () => ({})) => draft.gates.map((g) => ({ code: g.code, is_active: g.is_active !== false, ...over(g) }));
  const ok = (op: UndoOp, needsStruct: boolean, hint: string): UndoPlan => ({ ok: true, op, needsStruct, hint });
  switch (ch.key) {
    case 'ms_added': return ok({ door: 'removeItem', body: { kind: 'milestone', code: ch.code } }, true, 'remove');
    case 'g_added': return ok({ door: 'removeItem', body: { kind: 'gate', code: ch.code } }, true, 'remove');
    case 't_added': return ok({ door: 'removeItem', body: { kind: 'task', code: ch.code } }, true, 'remove');
    case 'ms_removed': case 'g_removed': return { ok: false, why: 'removed' };
    case 'ms_renamed': {
      if (!pm || !dm) return { ok: false, why: 'removed' };
      if ((pm.is_active !== false) !== (dm.is_active !== false)) return ok({ door: 'replace', body: { milestones: msList((m) => (m.code === ch.code ? { is_active: pm.is_active !== false, name_en: pm.name_en, name_ar: pm.name_ar ?? null } : {})), gates: gList() } }, true, 'restore');
      return ok({ door: 'msLight', body: { code: ch.code, name_en: pm.name_en, name_ar: pm.name_ar ?? '' } }, false, 'restore');
    }
    case 'ms_reordered': return ok({ door: 'replace', body: { milestones: msList(() => ({}), parent.milestones.map((m) => m.code)), gates: gList() } }, true, 'restore');
    case 'g_changed': {
      if (!pg || !dg) return { ok: false, why: 'removed' };
      if (pg.from_milestone !== dg.from_milestone || pg.to_milestone !== dg.to_milestone) return { ok: false, why: 'gate_ends' };
      if ((pg.sla_min_wd == null && dg.sla_min_wd != null) || (pg.sla_max_wd == null && dg.sla_max_wd != null)) return { ok: false, why: 'clear_sla' };
      const light = { name_en: pg.name_en, name_ar: pg.name_ar ?? '', ...(pg.sla_min_wd != null ? { sla_min_wd: pg.sla_min_wd } : {}), ...(pg.sla_max_wd != null ? { sla_max_wd: pg.sla_max_wd } : {}), conditions: pg.conditions ?? [] };
      if ((pg.is_active !== false) !== (dg.is_active !== false)) return ok({ door: 'replace', body: { milestones: msList(), gates: gList((g) => (g.code === ch.code ? { ...light, is_active: pg.is_active !== false } : {})) } }, true, 'restore');
      return ok({ door: 'gateLight', body: { code: ch.code, ...light } }, false, 'restore');
    }
    case 't_deactivated': return ok({ door: 'updateTask', body: { code: ch.code, is_active: true } }, false, 'restore');
    case 't_moved': {
      if (!pt) return { ok: false, why: 'removed' };
      if (!draft.milestones.some((m) => m.code === pt.stage_code && m.is_active !== false)) return { ok: false, why: 'stage_gone' };
      return ok({ door: 'updateTask', body: { code: ch.code, stage_code: pt.stage_code } }, true, 'restore');
    }
    case 't_renamed': return pt ? ok({ door: 'updateTask', body: { code: ch.code, name_en: pt.name_en ?? '', name_ar: pt.name_ar ?? null } }, false, 'restore') : { ok: false, why: 'removed' };
    case 't_relinked': {
      if (!pt) return { ok: false, why: 'removed' };
      const have = new Set(draft.placements.map((p) => p.task_code));
      if ((pt.predecessors ?? []).some((c) => !have.has(c))) return { ok: false, why: 'link_gone' };
      return ok({ door: 'setPreds', body: { code: ch.code, predecessors: pt.predecessors ?? [] } }, false, 'restore');
    }
    case 't_closing': return pt ? ok({ door: 'setClosing', body: { code: ch.code, closing: !!pt.is_milestone_task } }, true, 'restore') : { ok: false, why: 'removed' };
    case 'sla_changed': {
      const r = ps?.sla;
      if (r) return ok({ door: 'saveSla', body: { code: ch.code, min_working_days: r.min_working_days, max_working_days: r.max_working_days, start_event: r.start_event, unit: r.unit, calendar_code: r.calendar_code, warning_pct: r.warning_pct, breach_owner_role: r.breach_owner_role, escalation_role: r.escalation_role, pause_on_client_wait: r.pause_on_client_wait } }, false, 'restore');
      return ds?.sla ? ok({ door: 'removeSla', body: { code: ch.code, rule: ds.sla.id } }, false, 'remove') : { ok: false, why: 'removed' };
    }
    case 'weight_changed': return ps ? ok({ door: 'setWeight', body: ps.counts_in_weight ? { code: ch.code, counts_in_weight: true, weight_value: Number(ps.weight_value), weight_group: ps.weight_group } : { code: ch.code, counts_in_weight: false } }, false, 'restore') : { ok: false, why: 'removed' };
  }
}

/** The numbers of a migration preview: sites, tasks added and moved, dates that change (summed over the sites it lists). */
export function impactCounts(pv: Pick<MigrationPreview, 'sites'>) {
  const n = (f: (s: MigrationPreview['sites'][number]) => number) => pv.sites.reduce((a, s) => a + f(s), 0);
  const movable = pv.sites.filter((s) => s.migratable).length;
  return { sites: pv.sites.length, movable, blocked: pv.sites.length - movable, added: n((s) => s.tasks_added?.length ?? 0), moved: n((s) => s.tasks_moved?.length ?? 0), retired: n((s) => s.tasks_retired?.length ?? 0), dates: n((s) => s.date_changes?.length ?? 0) };
}

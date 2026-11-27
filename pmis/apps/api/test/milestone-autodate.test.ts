import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { superDb } from './helpers';

/**
 * Migration 0548 (0.15.269, owner decision 2026-11-27): the milestone and phase-gate date rule. On a site whose workflow is
 * version 2 or newer, a milestone task's date is the date of its last linked (predecessor) task and is set automatically, never
 * typed; a phase gate takes the milestone's date and nothing else, while its conditions and Change Control suspensions still
 * decide open/blocked. Sites on version 1 keep today's behaviour exactly: typed milestone dates, gates take the latest of their
 * conditions and shift past suspensions. No existing date is rewritten.
 */
let db: PgClient;

beforeAll(async () => {
  db = await superDb();
});
afterAll(async () => {
  await db.end();
});

const V2 = `(SELECT id FROM workflow_definitions WHERE version = 2)`;
const V1 = `(SELECT id FROM workflow_definitions WHERE version = 1)`;

async function withAdmin<T>(fn: () => Promise<T>): Promise<T> {
  await db.query('BEGIN');
  try {
    await db.query(`INSERT INTO users (id, display_name, status, email, updated_at) VALUES ('11111111-1111-1111-1111-111111111111', 'ms auto test', 'active', 'ms-auto-test@example.invalid', now())`);
    await db.query(`INSERT INTO groups (id, name, is_system_admins, is_active) VALUES ('22222222-2222-2222-2222-222222222222', 'ms auto test admins', true, true)`);
    await db.query(`INSERT INTO group_members (group_id, user_id) VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111')`);
    await db.query(`SELECT set_config('app.user_id', '11111111-1111-1111-1111-111111111111', true)`);
    await db.query(`SELECT set_config('app.region_ids', '*', true)`);
    await db.query(`UPDATE workflow_definitions SET status = 'published' WHERE version = 2`); // v2 is a draft in the seed; published only inside this transaction
    return await fn();
  } finally {
    await db.query('ROLLBACK');
  }
}

async function makeSite(code: string, version: number): Promise<void> {
  await db.query(
    `INSERT INTO sites (site_code, name, region_id, workflow_version_id, updated_at)
     SELECT $1, $1, 1, id, now() FROM workflow_definitions WHERE version = $2`,
    [code, version],
  );
}

async function approve(site: string, task: string, d: string): Promise<void> {
  await db.query(
    `INSERT INTO task_instances (site_id, region_id, task_def_id, state, current_level, levels_required, actual_date, approved_date, updated_at)
     SELECT s.id, 1, td.id, 'approved', 2, 2, $3::date, $3::date, now()
     FROM sites s JOIN task_definitions td ON td.workflow_id = s.workflow_version_id AND td.code = $2 WHERE s.site_code = $1`,
    [site, task, d],
  );
}

async function openEntry(site: string, task: string): Promise<void> {
  await db.query(
    `INSERT INTO task_instances (site_id, region_id, task_def_id, state, current_level, levels_required, updated_at)
     SELECT s.id, 1, td.id, 'entry', 0, 2, now()
     FROM sites s JOIN task_definitions td ON td.workflow_id = s.workflow_version_id AND td.code = $2 WHERE s.site_code = $1`,
    [site, task],
  );
}

const msTask = (site: string, task = 'MS3') =>
  db.query(
    `SELECT ti.id, ti.state, ti.actual_date::text AS actual, ti.version FROM task_instances ti
     JOIN task_definitions td ON td.id = ti.task_def_id JOIN sites s ON s.id = ti.site_id
     WHERE s.site_code = $1 AND td.code = $2`,
    [site, task],
  );

describe('the milestone auto-date on v2+ sites', () => {
  it('replaces a typed entry date with the date of the last linked task', async () => {
    await withAdmin(async () => {
      await makeSite('ZZ-AUTO-1', 2);
      for (const [t, d] of [['B10', '2026-11-18'], ['B11', '2026-11-20'], ['B12', '2026-11-22'], ['B16', '2026-11-15']] as const) await approve('ZZ-AUTO-1', t, d);
      await openEntry('ZZ-AUTO-1', 'MS3');
      const ms = (await msTask('ZZ-AUTO-1')).rows[0]!;
      await db.query(`SELECT public.wf_save_entry($1, $2, '{"actual_date": "2026-11-01"}'::jsonb)`, [ms.id, ms.version]);
      const after = (await msTask('ZZ-AUTO-1')).rows[0]!;
      expect(after.actual.slice(0, 10)).toBe('2026-11-22');
    });
  });

  it('leaves the date alone while a linked task is not approved yet', async () => {
    await withAdmin(async () => {
      await makeSite('ZZ-AUTO-2', 2);
      for (const [t, d] of [['B10', '2026-11-18'], ['B11', '2026-11-20'], ['B12', '2026-11-22']] as const) await approve('ZZ-AUTO-2', t, d);
      await openEntry('ZZ-AUTO-2', 'B16'); // still open
      await openEntry('ZZ-AUTO-2', 'MS3');
      const ms = (await msTask('ZZ-AUTO-2')).rows[0]!;
      await db.query(`SELECT public.wf_save_entry($1, $2, '{"actual_date": "2026-11-01"}'::jsonb)`, [ms.id, ms.version]);
      const after = (await msTask('ZZ-AUTO-2')).rows[0]!;
      expect(after.actual.slice(0, 10)).toBe('2026-11-01');
    });
  });

  it('dates Site RFI (MS4) by its last linked task: civil works, GECOL and HLC when the site requires them, latest wins', async () => {
    await withAdmin(async () => {
      await makeSite('ZZ-AUTO-4', 2);
      // MS3 chain: civil works done 2026-11-22
      for (const [t, d] of [['B10', '2026-11-18'], ['B11', '2026-11-20'], ['B12', '2026-11-22'], ['B16', '2026-11-15']] as const) await approve('ZZ-AUTO-4', t, d);
      await db.query(
        `INSERT INTO task_instances (site_id, region_id, task_def_id, state, current_level, levels_required, actual_date, approved_date, updated_at)
         SELECT s.id, 1, td.id, 'approved', 2, 2, '2026-11-22', '2026-11-22', now()
         FROM sites s JOIN task_definitions td ON td.workflow_id = s.workflow_version_id AND td.code = 'MS3' WHERE s.site_code = 'ZZ-AUTO-4'`);
      // CW PAC and GECOL done; the site does not require HLC, so C4 is skipped and must not count
      await approve('ZZ-AUTO-4', 'B13', '2026-11-25');
      await approve('ZZ-AUTO-4', 'C2', '2026-11-24');
      await db.query(
        `INSERT INTO task_instances (site_id, region_id, task_def_id, state, current_level, levels_required, updated_at)
         SELECT s.id, 1, td.id, 'skipped', 0, 2, now()
         FROM sites s JOIN task_definitions td ON td.workflow_id = s.workflow_version_id AND td.code = 'C4' WHERE s.site_code = 'ZZ-AUTO-4'`);
      await openEntry('ZZ-AUTO-4', 'MS4');
      const ms = (await msTask('ZZ-AUTO-4', 'MS4')).rows[0]!;
      await db.query(`SELECT public.wf_save_entry($1, $2, '{"actual_date": "2026-11-01"}'::jsonb)`, [ms.id, ms.version]);
      const after = (await msTask('ZZ-AUTO-4', 'MS4')).rows[0]!;
      expect(after.actual.slice(0, 10)).toBe('2026-11-25');
    });
  });

  it('computes the date at submit, so a milestone needs no typed date', async () => {
    await withAdmin(async () => {
      await makeSite('ZZ-AUTO-3', 2);
      for (const [t, d] of [['B10', '2026-11-18'], ['B11', '2026-11-20'], ['B12', '2026-11-22'], ['B16', '2026-11-15']] as const) await approve('ZZ-AUTO-3', t, d);
      await openEntry('ZZ-AUTO-3', 'MS3');
      const ms = (await msTask('ZZ-AUTO-3')).rows[0]!;
      await db.query(`SELECT public.wf_complete_hw($1, $2, 'submit', NULL, false, NULL)`, [ms.id, ms.version]);
      const after = (await db.query(
        `SELECT ti.actual_date::text AS actual, ti.submitted_date::text AS submitted FROM task_instances ti
         JOIN task_definitions td ON td.id = ti.task_def_id JOIN sites s ON s.id = ti.site_id
         WHERE s.site_code = 'ZZ-AUTO-3' AND td.code = 'MS3'`,
      )).rows[0]!;
      expect(after.actual.slice(0, 10)).toBe('2026-11-22');
      expect(after.submitted).not.toBeNull();
    });
  });
});

describe('the phase-gate date rule', () => {
  it('on v2 the gate takes the milestone date and a later condition does not move it', async () => {
    await withAdmin(async () => {
      await makeSite('ZZ-GATE-1', 2);
      for (const [t, d] of [['B10', '2026-11-18'], ['B11', '2026-11-20'], ['B12', '2026-11-22'], ['B16', '2026-11-15'], ['B13', '2026-11-25']] as const) await approve('ZZ-GATE-1', t, d);
      await db.query(
        `INSERT INTO task_instances (site_id, region_id, task_def_id, state, current_level, levels_required, actual_date, approved_date, updated_at)
         SELECT s.id, 1, td.id, 'approved', 2, 2, '2026-11-22', '2026-11-22', now()
         FROM sites s JOIN task_definitions td ON td.workflow_id = s.workflow_version_id AND td.code = 'MS3' WHERE s.site_code = 'ZZ-GATE-1'`);
      await db.query(`UPDATE phase_gate_rules SET conditions = '[{"ref": "B13", "type": "task"}]'::jsonb WHERE workflow_id = ${V2} AND link_code = 'G4'`);
      const g = (await db.query(`SELECT status, gate_date::text AS gd, base_date::text AS bd, shifted FROM public.gate_eval((SELECT id FROM sites WHERE site_code = 'ZZ-GATE-1'), 'G4')`)).rows[0]!;
      expect(g.status).toBe('open');
      expect(g.gd.slice(0, 10)).toBe('2026-11-22');
      expect(g.bd.slice(0, 10)).toBe('2026-11-22');
      expect(g.shifted).toBe(false);
    });
  });

  it('on v2 a suspension blocks or holds but never shifts the date', async () => {
    await withAdmin(async () => {
      await makeSite('ZZ-GATE-2', 2);
      for (const [t, d] of [['B10', '2026-11-18'], ['B11', '2026-11-20'], ['B12', '2026-11-22'], ['B16', '2026-11-15']] as const) await approve('ZZ-GATE-2', t, d);
      await db.query(
        `INSERT INTO task_instances (site_id, region_id, task_def_id, state, current_level, levels_required, actual_date, approved_date, updated_at)
         SELECT s.id, 1, td.id, 'approved', 2, 2, '2026-11-22', '2026-11-22', now()
         FROM sites s JOIN task_definitions td ON td.workflow_id = s.workflow_version_id AND td.code = 'MS3' WHERE s.site_code = 'ZZ-GATE-2'`);
      await db.query(
        `INSERT INTO change_requests (site_id, region_id, is_global, change_code, kind, status, requested_by, suspension_start, approval_date)
         VALUES ((SELECT id FROM sites WHERE site_code = 'ZZ-GATE-2'), 1, false, 'ZZ-CR-S1', 'suspension', 'approved', '11111111-1111-1111-1111-111111111111', '2026-11-21', '2026-11-21')`);
      await db.query(
        `INSERT INTO change_requests (site_id, region_id, is_global, change_code, kind, status, requested_by, resumption_date, approval_date)
         VALUES ((SELECT id FROM sites WHERE site_code = 'ZZ-GATE-2'), 1, false, 'ZZ-CR-R1', 'resumption', 'approved', '11111111-1111-1111-1111-111111111111', '2026-12-05', '2026-12-05')`);
      const g = (await db.query(`SELECT status, gate_date::text AS gd, shifted FROM public.gate_eval((SELECT id FROM sites WHERE site_code = 'ZZ-GATE-2'), 'G4')`)).rows[0]!;
      expect(g.status).toBe('open');
      expect(g.gd.slice(0, 10)).toBe('2026-11-22');
      expect(g.shifted).toBe(false);
    });
  });

  it('on v1 nothing changes: typed milestone dates stand and gates take the latest condition and shift past suspensions', async () => {
    await withAdmin(async () => {
      await makeSite('ZZ-GATE-3', 1);
      for (const [t, d] of [['B10', '2026-11-18'], ['B11', '2026-11-20'], ['B13', '2026-11-25']] as const) await approve('ZZ-GATE-3', t, d);
      await db.query(
        `INSERT INTO task_instances (site_id, region_id, task_def_id, state, current_level, levels_required, actual_date, approved_date, updated_at)
         SELECT s.id, 1, td.id, 'approved', 2, 2, '2026-11-01', '2026-11-22', now()
         FROM sites s JOIN task_definitions td ON td.workflow_id = s.workflow_version_id AND td.code = 'MS3' WHERE s.site_code = 'ZZ-GATE-3'`);
      await db.query(`UPDATE phase_gate_rules SET conditions = '[{"ref": "B13", "type": "task"}]'::jsonb WHERE workflow_id = ${V1} AND link_code = 'G4'`);
      // the auto-date helper is a no-op on v1: a typed milestone date is never rewritten
      const ms = (await msTask('ZZ-GATE-3')).rows[0]!;
      await db.query(`SELECT public.wf_milestone_auto_date($1)`, [ms.id]);
      expect(((await msTask('ZZ-GATE-3')).rows[0]!.actual as string).slice(0, 10)).toBe('2026-11-01');
      // the gate still takes the latest condition and shifts past a suspension
      await db.query(
        `INSERT INTO change_requests (site_id, region_id, is_global, change_code, kind, status, requested_by, suspension_start, approval_date)
         VALUES ((SELECT id FROM sites WHERE site_code = 'ZZ-GATE-3'), 1, false, 'ZZ-CR-S2', 'suspension', 'approved', '11111111-1111-1111-1111-111111111111', '2026-11-24', '2026-11-24')`);
      await db.query(
        `INSERT INTO change_requests (site_id, region_id, is_global, change_code, kind, status, requested_by, resumption_date, approval_date)
         VALUES ((SELECT id FROM sites WHERE site_code = 'ZZ-GATE-3'), 1, false, 'ZZ-CR-R2', 'resumption', 'approved', '11111111-1111-1111-1111-111111111111', '2026-12-05', '2026-12-05')`);
      const g = (await db.query(`SELECT status, gate_date::text AS gd, shifted FROM public.gate_eval((SELECT id FROM sites WHERE site_code = 'ZZ-GATE-3'), 'G4')`)).rows[0]!;
      expect(g.status).toBe('open');
      expect(g.gd.slice(0, 10)).toBe('2026-12-05');
      expect(g.shifted).toBe(true);
    });
  });
});

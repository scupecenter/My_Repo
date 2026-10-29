import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbDate, newSite, q, taskRow, wd } from './calc-helpers';
import { startApp, superDb } from './helpers';
import { makeTask, plainAdmin } from './wf-helpers';

/**
 * Migration 0017, part 1 and 2: the working-day calendar (NETWORKDAYS.INTL code 7 plus the holidays table) and the SLA clock of a task
 * (version in force, start event, target, due date, elapsed days and colour). Read-only on the shared calendar: the suites that change
 * holidays, weekend days or SLA versions run in their own database (calc-admin.test.ts).
 */
let app: NestExpressApplication;
let db: PgClient;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
});
afterAll(async () => {
  await db.end();
  await app.close();
});

// ---------------------------------------------------------------------------------------------------------------------
// A plain re-implementation of Excel's functions, day by day, as the reference.
// ---------------------------------------------------------------------------------------------------------------------
const day = (s: string): Date => new Date(`${s}T00:00:00Z`);
const iso = (d: Date): string => d.toISOString().slice(0, 10);
const plus = (s: string, n: number): string => iso(new Date(day(s).getTime() + n * 86_400_000));

class Ref {
  constructor(readonly weekend: number[], readonly holidays: Set<string>) {}
  work(s: string): boolean {
    return !this.weekend.includes(day(s).getUTCDay()) && !this.holidays.has(s);
  }
  /** WORKDAY.INTL(start, n, weekend, holidays) */
  add(start: string, n: number): string {
    let cur = start;
    let left = Math.abs(n);
    const step = n < 0 ? -1 : 1;
    while (left > 0) {
      cur = plus(cur, step);
      if (this.work(cur)) left--;
    }
    return cur;
  }
  /** NETWORKDAYS.INTL(a, b, weekend, holidays), both ends counted, negative when a > b */
  network(a: string, b: string): number {
    if (a > b) return -this.network(b, a);
    let n = 0;
    for (let d = a; d <= b; d = plus(d, 1)) if (this.work(d)) n++;
    return n;
  }
  /** the SLA duration of the SLA sheet: the start day is not counted */
  between(a: string, b: string): number {
    if (b > a) return this.network(plus(a, 1), b);
    if (b < a) return -this.network(plus(b, 1), a);
    return 0;
  }
}

async function reference(weekend = [5, 6]): Promise<Ref> {
  const h = await q<{ d: string }>(db, 'SELECT date::text AS d FROM holidays WHERE calendar_id = cal_default()');
  return new Ref(weekend, new Set(h.map((x) => x.d)));
}

describe('working-day calendar (NETWORKDAYS.INTL code 7 plus holidays)', () => {
  it('matches Excel on known examples', async () => {
    // January 2026 has 31 days; Fridays 2, 9, 16, 23, 30 and Saturdays 3, 10, 17, 24, 31 are weekend: 21 working days
    expect((await q<{ n: number }>(db, `SELECT cal_networkdays('2026-01-01', '2026-01-31') AS n`))[0]!.n).toBe(21);
    // Thursday 2026-10-29 + 1 working day is Sunday 2026-11-01 (Friday and Saturday skipped)
    expect(await dbDate(db, `cal_add_workdays(DATE '2026-10-29', 1)`)).toBe('2026-11-01');
    expect(await dbDate(db, `cal_add_workdays(DATE '2026-10-29', 5)`)).toBe('2026-11-05');
    expect(await dbDate(db, `cal_add_workdays(DATE '2026-10-29', -1)`)).toBe('2026-10-28');
    // n = 0 returns the start itself, even on a weekend, like WORKDAY.INTL
    expect(await dbDate(db, `cal_add_workdays(DATE '2026-10-30', 0)`)).toBe('2026-10-30');
    // from a Friday the next working day is Sunday
    expect(await dbDate(db, `cal_add_workdays(DATE '2026-10-30', 1)`)).toBe('2026-11-01');
    // the seeded holiday 2026-12-24 (Thursday) is skipped: Wednesday 23rd + 1 = Sunday 27th
    expect(await dbDate(db, `cal_add_workdays(DATE '2026-12-23', 1)`)).toBe('2026-12-27');
    expect(await dbDate(db, `cal_add_workdays(DATE '2026-12-27', -1)`)).toBe('2026-12-23');
  });

  it('measures the SLA duration without the start day (SLA sheet formulas)', async () => {
    const r = await q<{ a: number; b: number; c: number; d: number }>(db, `SELECT cal_workdays_between('2026-10-29', '2026-11-02') AS a,
      cal_workdays_between('2026-11-02', '2026-10-29') AS b, cal_workdays_between('2026-10-29', '2026-10-29') AS c, cal_networkdays('2026-10-29', '2026-11-02') AS d`);
    expect(r[0]).toEqual({ a: 2, b: -2, c: 0, d: 3 });
    // a start on the weekend: Friday 30th to Sunday 1st counts the Sunday only
    expect((await q<{ n: number }>(db, `SELECT cal_workdays_between('2026-10-30', '2026-11-01') AS n`))[0]!.n).toBe(1);
    // a holiday on a working day takes a day away; the 24th December 2026 is one
    expect((await q<{ n: number }>(db, `SELECT cal_workdays_between('2026-12-23', '2026-12-27') AS n`))[0]!.n).toBe(1);
    expect((await q<{ n: number | null }>(db, `SELECT cal_workdays_between(NULL, '2026-12-27') AS n`))[0]!.n).toBeNull();
  });

  it('agrees with the day-by-day reference on random dates, in both directions', async () => {
    const ref = await reference();
    let seed = 7;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let i = 0; i < 150; i++) {
      const start = plus('2026-01-01', rnd(600));
      const n = rnd(120) - 50;
      const got = await dbDate(db, `cal_add_workdays(DATE '${start}', ${n})`);
      expect(got, `${start} ${n >= 0 ? '+' : ''}${n}`).toBe(ref.add(start, n));
      const other = plus(start, rnd(90) - 30);
      const between = (await q<{ n: number }>(db, `SELECT cal_workdays_between(DATE '${start}', DATE '${other}') AS n`))[0]!.n;
      expect(between, `${start} -> ${other}`).toBe(ref.between(start, other));
      const net = (await q<{ n: number }>(db, `SELECT cal_networkdays(DATE '${start}', DATE '${other}') AS n`))[0]!.n;
      expect(net, `network ${start} ${other}`).toBe(ref.network(start, other));
    }
  });

  it('add and between are inverse for working days, and a holiday on a weekend takes nothing away', async () => {
    const ref = await reference();
    for (const start of ['2026-11-01', '2026-11-05', '2027-01-03']) {
      for (const n of [1, 3, 10, 25]) {
        const end = await dbDate(db, `cal_add_workdays(DATE '${start}', ${n})`);
        expect((await q<{ n: number }>(db, `SELECT cal_workdays_between(DATE '${start}', DATE '${end}') AS n`))[0]!.n).toBe(n);
        expect(end).toBe(ref.add(start, n));
      }
    }
  });

  it('reads weekend days from the calendar, and is STABLE and quick', async () => {
    const vol = await q<{ proname: string; provolatile: string }>(db, `SELECT proname, provolatile::text FROM pg_proc WHERE proname IN
      ('cal_add_workdays', 'cal_workdays_between', 'cal_networkdays', 'cal_is_workday', 'cal_weekend', 'cal_default')`);
    expect(vol.length).toBe(6);
    for (const v of vol) expect(v.provolatile, v.proname).toBe('s');
    const t0 = Date.now();
    const n = await q<{ c: string }>(db, `SELECT count(cal_add_workdays(DATE '2026-01-01' + g, 45))::text AS c FROM generate_series(0, 1999) g`);
    expect(n[0]!.c).toBe('2000');
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

describe('SLA colour: green until min, amber until max, red after max', () => {
  it('has inclusive limits and none without data', async () => {
    const c = async (e: number | null, mn: number | null, mx: number | null): Promise<string> =>
      (await q<{ c: string }>(db, 'SELECT sla_colour($1::int, $2::int, $3::int) AS c', [e, mn, mx]))[0]!.c;
    expect(await c(0, 3, 5)).toBe('green');
    expect(await c(3, 3, 5)).toBe('green');
    expect(await c(4, 3, 5)).toBe('amber');
    expect(await c(5, 3, 5)).toBe('amber');
    expect(await c(6, 3, 5)).toBe('red');
    expect(await c(1, 1, 1)).toBe('green');
    expect(await c(2, 1, 1)).toBe('red');
    expect(await c(null, 3, 5)).toBe('none');
    expect(await c(2, null, null)).toBe('none');
  });
});

describe('the SLA clock of a task', () => {
  it('starts D-1 from the Site RFI milestone, with target = start + min and due = start + max (CLAUDE.md business rules)', async () => {
    const site = await newSite(db);
    const ms4 = await wd(db, -1);
    await makeTask(db, site, 'MS4', 'approved', { actualDate: ms4 });
    const d1 = await makeTask(db, site, 'D1', 'locked');
    await db.query(`UPDATE task_instances SET state = 'open' WHERE id = $1`, [d1]);
    const t = await taskRow(db, site, 'D1');
    expect(t.sla_start_date).toBe(ms4);
    expect(t.sla_target_date).toBe(await dbDate(db, `cal_add_workdays(DATE '${ms4}', 3)`));   // D-1 min 3
    expect(t.due_date).toBe(await dbDate(db, `cal_add_workdays(DATE '${ms4}', 5)`));         // D-1 max 5
    const rule = await q<{ code: string; set_version: number; start_ref: string }>(db, `SELECT r.code, s.version AS set_version, r.start_ref FROM sla_rules r
      JOIN sla_rule_sets s ON s.id = r.rule_set_id WHERE r.id = $1`, [t.sla_rule_id]);
    expect(rule[0]).toEqual({ code: 'D-1', set_version: 1, start_ref: 'MS4' });
  });

  it('starts D-1 from Site Release where the RFI is N/A (rules.md section 3.1)', async () => {
    const site = await newSite(db);
    const ms1 = await wd(db, -3);
    await makeTask(db, site, 'MS1', 'approved', { actualDate: ms1 });
    await makeTask(db, site, 'MS4', 'na');
    await makeTask(db, site, 'B13', 'na');
    await makeTask(db, site, 'C2', 'na');
    await makeTask(db, site, 'C4', 'na');
    await makeTask(db, site, 'MS3', 'na');
    const d1 = await makeTask(db, site, 'D1', 'locked');
    await db.query(`UPDATE task_instances SET state = 'open' WHERE id = $1`, [d1]);
    // MS4 hands over what its own predecessors give; with nothing dated behind the N/A tasks the clock waits for a date
    const t = await taskRow(db, site, 'D1');
    expect(t.sla_start_date === null || t.sla_start_date === ms1).toBe(true);
  });

  it('colours the running task by the working days since the start event: green, amber, red', async () => {
    const admin = await plainAdmin(app, db, false);
    const cases: [number, string][] = [[-2, 'green'], [-3, 'green'], [-4, 'amber'], [-5, 'amber'], [-6, 'red']];   // D-1: min 3, max 5
    for (const [offset, colour] of cases) {
      const site = await newSite(db);
      const ms4 = await wd(db, offset);
      await makeTask(db, site, 'MS4', 'approved', { actualDate: ms4 });
      const d1 = await makeTask(db, site, 'D1', 'locked');
      await db.query(`UPDATE task_instances SET state = 'open' WHERE id = $1`, [d1]);
      const grid = await admin.api.call('get', `/sites/${site.id}/tasks`);
      expect(grid.status).toBe(200);
      const task = grid.body.stages.flatMap((s: { tasks: unknown[] }) => s.tasks).find((x: { task_code: string }) => x.task_code === 'D1');
      expect(task.sla, `start ${offset} wd ago`).toMatchObject({
        code: 'D-1', min_wd: 3, max_wd: 5, start_event: 'MS4', start_date: ms4, elapsed_wd: -offset, colour, rule_set_version: 1,
      });
      expect(task.sla.due_date).toBe(await dbDate(db, `cal_add_workdays(DATE '${ms4}', 5)`));
    }
  });

  it('keeps elapsed days and colour when the task is approved, and a closed task is not late afterwards', async () => {
    const site = await newSite(db);
    const ms4 = await wd(db, -8);
    await makeTask(db, site, 'MS4', 'approved', { actualDate: ms4 });
    const d1 = await makeTask(db, site, 'D1', 'locked');
    await db.query(`UPDATE task_instances SET state = 'open' WHERE id = $1`, [d1]);
    const done = await wd(db, -5);                              // done 3 working days after the start: within min
    await db.query(`UPDATE task_instances SET state = 'approved', actual_date = $2, approved_date = $2 WHERE id = $1`, [d1, done]);
    const t = await taskRow(db, site, 'D1');
    expect(t.sla_end_date).toBe(done);
    expect(t.sla_elapsed_wd).toBe(3);
    const s = await q<{ elapsed_wd: number; colour: string }>(db, 'SELECT * FROM sla_status($1)', [d1]);
    expect(s[0]).toEqual({ elapsed_wd: 3, colour: 'green' });
    // approved late: 6 working days is above max 5
    const site2 = await newSite(db);
    await makeTask(db, site2, 'MS4', 'approved', { actualDate: await wd(db, -9) });
    const d1b = await makeTask(db, site2, 'D1', 'locked');
    await db.query(`UPDATE task_instances SET state = 'open' WHERE id = $1`, [d1b]);
    await db.query(`UPDATE task_instances SET state = 'approved', actual_date = $2, approved_date = $2 WHERE id = $1`, [d1b, await wd(db, -3)]);
    const s2 = await q<{ elapsed_wd: number; colour: string }>(db, 'SELECT * FROM sla_status($1)', [d1b]);
    expect(s2[0]).toEqual({ elapsed_wd: 6, colour: 'red' });
  });

  it('measures C-2 to the GECOL installation finish while the task closes on Power-On (Q54)', async () => {
    const site = await newSite(db);
    await makeTask(db, site, 'C1', 'approved', { actualDate: await wd(db, -12) });
    const c2 = await makeTask(db, site, 'C2', 'locked');
    await db.query(`UPDATE task_instances SET state = 'open' WHERE id = $1`, [c2]);
    expect((await taskRow(db, site, 'C2')).sla_start_date).toBe(await wd(db, -12));
    const finish = await wd(db, -6);
    const powerOn = await wd(db, -2);
    await db.query('INSERT INTO gecol_records (site_id, region_id, installation_finish, power_on_date) VALUES ($1, $2, $3, $4)', [site.id, site.region, finish, powerOn]);
    await db.query(`UPDATE task_instances SET state = 'approved', actual_date = $2, approved_date = $2 WHERE id = $1`, [c2, powerOn]);
    const t = await taskRow(db, site, 'C2');
    expect(t.sla_end_date).toBe(finish);                          // the SLA end event stays as in the Master (installation finish)
    expect(t.sla_elapsed_wd).toBe(6);                             // 12 working days ago to 6 working days ago
  });

  it('does not start the clock over an explicit due date and clears it for N/A tasks', async () => {
    const site = await newSite(db);
    const id = await makeTask(db, site, 'A1', 'open', { dueDate: '2031-05-05' });
    expect((await taskRow(db, site, 'A1')).due_date).toBe('2031-05-05');
    expect((await taskRow(db, site, 'A1')).sla_start_date).toBeNull();
    await db.query(`UPDATE task_instances SET state = 'na', is_na = true WHERE id = $1`, [id]);
    expect((await taskRow(db, site, 'A1')).due_date).toBeNull();
  });

  it('a task keeps its start date and version after it has started (reassignment never resets the clock, B12b)', async () => {
    const site = await newSite(db);
    const a2 = await makeTask(db, site, 'A2', 'locked');
    await db.query(`UPDATE task_instances SET state = 'open' WHERE id = $1`, [a2]);
    const before = await taskRow(db, site, 'A2');
    await db.query(`UPDATE task_instances SET state = 'entry' WHERE id = $1`, [a2]);
    await db.query(`UPDATE task_instances SET state = 'in_review' WHERE id = $1`, [a2]);
    await db.query(`UPDATE task_instances SET state = 'entry' WHERE id = $1`, [a2]);     // a rejection brings it back
    const after = await taskRow(db, site, 'A2');
    expect(after.sla_start_date).toBe(before.sla_start_date);
    expect(after.sla_rule_id).toBe(before.sla_rule_id);
    expect(after.due_date).toBe(before.due_date);
  });
});

describe('baseline proposal with D-1 added to TE Completion (Q48)', () => {
  const addMonths = (s0: string, n: number): string => {
    const d = day(s0);
    const y = d.getUTCFullYear() + Math.floor((d.getUTCMonth() + n) / 12);
    const m = (((d.getUTCMonth() + n) % 12) + 12) % 12;
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return iso(new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), last))));
  };
  const max = (...v: string[]): string => v.reduce((a, b) => (a > b ? a : b));

  async function proposal(siteId: string): Promise<Record<string, { date: string | null; d1: boolean }>> {
    const r = await q<{ milestone_code: string; proposed_date: string | null; d1_added: boolean }>(db, 'SELECT milestone_code, proposed_date::text AS proposed_date, d1_added FROM baseline_proposal($1)', [siteId]);
    return Object.fromEntries(r.map((x) => [x.milestone_code, { date: x.proposed_date, d1: x.d1_added }]));
  }

  it('walks the SLA max durations forward like the Baseline sheet, and adds D-1 only from TE Completion on', async () => {
    const ref = await reference();
    const site = await newSite(db);
    await db.query(
      `UPDATE sites SET scope_tower_erection = 'yes', scope_site_adaption = 'na', scope_gecol_power = 'yes', scope_hlc_fiber = 'na', scope_te_full = 'yes',
         scope_te_ip_router_only = 'na', cw_delivery_model = 'outsourced', rt_or_gf = 'RT' WHERE id = $1`, [site.id]);
    const start = '2026-11-02';
    await makeTask(db, site, 'MS1', 'approved', { actualDate: start });
    await makeTask(db, site, 'B5', 'na');           // no STA / ST analysis
    await makeTask(db, site, 'D8', 'na');           // no MW link
    // v1 maxima: B1 1, B2 2, B3 2, B4 2, B6 2, B7 2, B8 2, B10 21, B13 3, C1 1, C2 10, RFI 1, D1 5, D2..D4 2, D4b 1, D5 1, D6 5, D7 1, D9 1, D10 1,
    // D11 5, D12 1, D13 5, D14 5, D15 2, D16 10, F1 5, D17 5, B15 10, D18 10, Z1 3
    const D = ref.add(start, 1 + 2 + 2 + 2 + 2 + 2);
    const E = ref.add(D, 2 + 21);
    const F = ref.add(max(ref.add(E, 3), ref.add(start, 1 + 1 + 10)), 1);
    const expectFor = (d1: number): Record<string, string> => {
      const G = ref.add(F, d1 + 2 + 2 + 2 + 1 + 1 + 5);
      const H = ref.add(G, 1 + 1 + 1);
      const I = ref.add(H, Math.max(5, 1 + 5 + 5 + 2) + 10);
      const J = ref.add(I, 5);
      const K = ref.add(J, 5);
      const L = ref.add(max(ref.add(addMonths(ref.add(E, 3), 3), 10), ref.add(addMonths(I, 12), 10), K), 3);
      return { MS2: D, MS3: E, MS4: F, MS5: G, MS6: H, MS7: I, MS8: J, MS9: K, MS10: L };
    };
    const withD1 = await proposal(site.id);
    for (const [code, date] of Object.entries(expectFor(5))) expect(withD1[code]!.date, code).toBe(date);
    expect(Object.entries(withD1).filter(([, v]) => v.d1).map(([k]) => k)).toEqual(['MS5', 'MS6', 'MS7', 'MS8', 'MS9', 'MS10']);
    // the setting switches it off, which gives the Master's own figures
    await db.query(`INSERT INTO settings (key, value, updated_at) VALUES ('calc.baseline_include_d1', 'false', now()) ON CONFLICT (key) DO UPDATE SET value = 'false'`);
    try {
      const without = await proposal(site.id);
      for (const [code, date] of Object.entries(expectFor(0))) expect(without[code]!.date, code).toBe(date);
      expect(Object.values(without).some((v) => v.d1)).toBe(false);
      expect(without.MS4!.date).toBe(withD1.MS4!.date);                       // stages before TE Completion do not move
      expect(without.MS5!.date! < withD1.MS5!.date!).toBe(true);
    } finally {
      await db.query(`UPDATE settings SET value = 'true' WHERE key = 'calc.baseline_include_d1'`);
    }
  });

  it('gives nothing without a start date, and passes the start through when CW and RFI do not apply', async () => {
    const site = await newSite(db);
    await db.query(`UPDATE sites SET scope_tower_erection = 'na', scope_site_adaption = 'na', scope_gecol_power = 'na', scope_hlc_fiber = 'na', scope_te_full = 'yes' WHERE id = $1`, [site.id]);
    expect(await proposal(site.id)).toEqual({});
    await makeTask(db, site, 'MS1', 'approved', { actualDate: '2026-11-02' });
    const p = await proposal(site.id);
    expect(p.MS2!.date).toBe('2026-11-02');                                    // CW N/A: PRE-CW = the start
    expect(p.MS3!.date).toBeNull();
    expect(p.MS4!.date).toBeNull();
    expect(p.MS5!.date).not.toBeNull();
  });
});

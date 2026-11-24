import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { decodeTypedCursor, encodeCursor, parseLimit } from '../common/cursor';
import { problems } from '../common/problem';
import { TS_TEXT, oneParam } from '../common/query';
import { DbService } from '../db/db.service';
import { parseSiteSearch, pastedSearchResult, siteScope, siteSearchCond, type PastedSearchDto } from '../common/site-search';
import { FilterCatalogService } from '../views/filter-catalog.service';
import { TaskSummaryDto, TaskViewService, taskSelect, timingFilters } from './task-view.service';

const BUCKETS = ['late', 'do_now', 'waiting'] as const;
type Bucket = (typeof BUCKETS)[number];

/**
 * GET /me/tasks (My Work, contract 0.2; built with F2, contract 0.15.30). The open tasks of the caller, in three buckets:
 *  - do_now: at a level the caller may act on now (an eligible holder not blocked by another member's claim, the claimant, or an
 *    "all members" voter who has not voted yet), and not late;
 *  - late: the same tasks whose SLA is past its maximum (colour red);
 *  - waiting: tasks the caller submitted last that now sit at a later level the caller does not hold.
 * Without a bucket: do_now and late together. The B3 scope of the Sites module applies (and row security). The F2 filters `sla_colour` and
 * `stale` narrow every bucket. Oldest level first (the ball held longest on top), keyset paged.
 */
@Injectable()
export class MyWorkService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly view: TaskViewService,
    private readonly filters: FilterCatalogService,
  ) {}

  async list(auth: AuthContext, q: Record<string, unknown>): Promise<{ items: TaskSummaryDto[]; page: { limit: number; next_cursor: string | null }; counts: { total: number; filtered: number }; search?: PastedSearchDto }> {
    const regions = await this.access.requireRegions('sites', 'view');
    const limit = parseLimit(oneParam(q, 'limit'));
    const bucket = oneParam(q, 'bucket');
    if (bucket !== undefined && !BUCKETS.includes(bucket as Bucket)) {
      throw problems.validation([{ path: '/bucket', code: 'invalid', message: 'bucket is late, do_now or waiting.' }]);
    }
    const cursor = decodeTypedCursor(oneParam(q, 'cursor'), ['ts', 'uuid']);
    const me = auth.user.id;

    // the caller can act at the current level now (the same rule as the Approvals inbox, for every level including Data Entry)
    const mine = Prisma.sql`coalesce(
      t.ball_in_court_user_id = ${me}::uuid
      OR (k.rule::text = 'all_members' AND EXISTS (SELECT 1 FROM task_level_voters v WHERE v.task_id = t.id AND v.level = t.current_level AND v.round = t.level_round
                                                  AND v.user_id = ${me}::uuid AND v.voted_at IS NULL))
      OR (k.rule::text <> 'all_members' AND wf_is_eligible(t.id, k.kind, ${me}::uuid)
          AND (t.ball_in_court_user_id IS NULL OR NOT wf_is_eligible(t.id, k.kind, t.ball_in_court_user_id))),
      false)`; // never null, so NOT mine is a plain boolean
    const conds: Prisma.Sql[] = [Prisma.sql`t.state IN ('open', 'entry', 'in_review', 'in_approval')`, Prisma.sql`k.kind IS NOT NULL`];
    if (regions !== null) conds.push(Prisma.sql`t.region_id = ANY(${regions}::int[])`);
    if (bucket === 'waiting') {
      conds.push(Prisma.sql`t.state IN ('in_review', 'in_approval')`);
      conds.push(Prisma.sql`(SELECT w.acted_by FROM workflow_steps w WHERE w.task_id = t.id AND w.action::text = 'submit' ORDER BY w.created_at DESC LIMIT 1) = ${me}::uuid`);
      conds.push(Prisma.sql`NOT ${mine}`);
    } else {
      conds.push(mine);
      if (bucket === 'late') conds.push(Prisma.sql`sl.colour = 'red'`);
      if (bucket === 'do_now') conds.push(Prisma.sql`coalesce(sl.colour, 'none') <> 'red'`);
    }
    // W8 (0.15.68): total = the bucket as it is; the search (one token: contains on site and task; a pasted list: each Site ID), the F2 timing
    // filters and the + Filter tree (the tasks board whitelist) narrow it to the filtered count
    const scope = [...conds];
    const search = parseSiteSearch(oneParam(q, 'q'));
    const byText = siteSearchCond(search, 's', [Prisma.sql`td.name_en`, Prisma.sql`td.code`]);
    if (byText) conds.push(byText);
    conds.push(...timingFilters(q));
    const adv = await this.filters.fromQuery('tasks-board', q);
    if (adv) conds.push(adv);
    const counts = { total: await this.view.count(Prisma.join(scope, ' AND ')), filtered: await this.view.count(Prisma.join(conds, ' AND ')) };
    // found / not found: the caller's Sites view regions, as the rows themselves
    const pasted = await pastedSearchResult(this.db.tx, search, siteScope(regions));
    const key = Prisma.raw('coalesce(t.level_opened_at, t.updated_at)');
    if (cursor) conds.push(Prisma.sql`(${key}, t.id) > (${cursor[0] as string}::timestamptz, ${cursor[1] as string}::uuid)`);

    const rows = await this.view.rows(taskSelect(Prisma.join(conds, ' AND '), Prisma.sql`ORDER BY ${key}, t.id LIMIT ${limit + 1}`));
    const page = rows.slice(0, limit);
    const items = await this.view.withLockReasons(page);
    let next: string | null = null;
    if (rows.length > limit && page.length) {
      const last = page[page.length - 1]!;
      const ts = await this.db.tx.$queryRaw<{ ts: string }[]>(
        Prisma.sql`SELECT ${Prisma.raw(TS_TEXT('coalesce(t.level_opened_at, t.updated_at)'))} AS ts FROM task_instances t WHERE t.id = ${last.id}::uuid`);
      if (ts[0]) next = encodeCursor([ts[0].ts, last.id]);
    }
    return { items, page: { limit, next_cursor: next }, counts, ...(pasted ? { search: pasted } : {}) };
  }
}

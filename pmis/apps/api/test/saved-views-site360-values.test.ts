import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes } from 'node:crypto';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, superDb } from './helpers';
import { actor, Actor, makeSite } from './wf-helpers';
import type { Site } from './wf-helpers';

/**
 * Contract 0.15.49 (migration 0138): saved views of the screens `site360-<menu>` and `dashboard`, and the server-side search of the value lists
 * (GET /saved-views/filter-fields/{field}/values). Everything runs in the shared test database: every site and value written here carries this file's tag, and
 * every filter tree starts with a condition on the tag, so other files' data never counts.
 */
const TAG = randomBytes(3).toString('hex').toUpperCase();
let app: NestExpressApplication;
let db: PgClient;

type Tree = { op: 'and' | 'or'; items: unknown[] };
const cond = (field: string, operator: string, value?: unknown) => ({
  field,
  operator,
  ...(value === undefined ? {} : { value }),
});
const mine = (...items: unknown[]): Tree => ({
  op: 'and',
  items: [cond('site_code', 'contains', TAG), ...items],
});
const q = (tree: Tree): string =>
  `filter=${encodeURIComponent(JSON.stringify(tree))}`;
const SITES_VIEW: [string, string][] = [['sites', 'view']];
const DASH_VIEW: [string, string][] = [
  ['dashboard', 'view'],
  ['sites', 'view'],
];
const LEAD: [string, string][] = [
  ['sites', 'view'],
  ['dashboard', 'view'],
  ['views', 'create'],
];
const nm = (s: string): string => `${s} ${TAG}`;
const create = (a: Actor, body: Record<string, unknown>) =>
  a.api.call('post', '/saved-views', body);
const idsOf = (body: { items: { id: string }[] }): string[] =>
  body.items.map((v) => v.id);
const values = (a: Actor, screen: string, field: string, query = '') =>
  a.api.call(
    'get',
    `/saved-views/filter-fields/${encodeURIComponent(field)}/values?screen_key=${screen}${query ? `&${query}` : ''}`,
  );
const valueList = (body: { items: { value: string }[] }): string[] =>
  body.items.map((i) => i.value);
const rowCodes = async (
  a: Actor,
  menu: string,
  tree: Tree,
): Promise<string[]> => {
  const res = await a.api.call(
    'get',
    `/site360/${menu}/rows?limit=200&${q(tree)}`,
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (res.body.rows as { site_code: string }[])
    .map((r) => r.site_code)
    .sort();
};

let tri1: Site, tri2: Site, ben: Site;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  tri1 = await makeSite(db, 1, { prefix: `SV${TAG}A`, scenario: 'new_build' });
  tri2 = await makeSite(db, 1, { prefix: `SV${TAG}B`, scenario: 'expansion' });
  ben = await makeSite(db, 5, { prefix: `SV${TAG}D`, scenario: 'hot_swap' });
  await db.query(
    'UPDATE sites SET sub_region = $1 WHERE id = ANY($2::uuid[])',
    [`SVA-${TAG}`, [tri1.id, tri2.id]],
  );
  await db.query('UPDATE sites SET sub_region = $1 WHERE id = $2', [
    `SVB-${TAG}`,
    ben.id,
  ]);
});
afterAll(async () => {
  await db.end();
  await app.close();
});

describe('saved views of a Site Master menu and of the dashboard', () => {
  it('saves and loads a sub-menu view: the filter tree, the quick parameters, the layout and the column order; the saved tree filters the rows', async () => {
    const a = await actor(app, db, { regions: null, grants: SITES_VIEW });
    const tree = mine(cond('sub_region', 'is', `SVA-${TAG}`));
    const body = {
      screen_key: 'site360-cw',
      name: nm('CW Tripoli'),
      filters: {
        q: '',
        region_id: '1',
        scenario: '',
        overall_status: '',
        site_codes: '',
        layout: 'wide',
        advanced: tree,
      },
      columns: {
        order: ['c2', 'c4', 'c40'],
        hidden: ['c40'],
        width: { c4: 300 },
        density: 'compact',
      },
      sort: [{ id: 'c2', dir: 'asc' }],
    };
    const res = await create(a, body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      screen_key: 'site360-cw',
      is_owner: true,
      shared: false,
      version: 1,
      filters: body.filters,
      columns: body.columns,
      sort: body.sort,
    });
    const id = res.body.id as string;

    const back = await a.api.call('get', `/saved-views/${id}`);
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({
      filters: body.filters,
      columns: body.columns,
      stripped_columns: 0,
    });
    const list = await a.api.call('get', '/saved-views?screen_key=site360-cw');
    expect(idsOf(list.body)).toContain(id);
    expect(
      idsOf(
        (await a.api.call('get', '/saved-views?screen_key=site360-te')).body,
      ),
    ).not.toContain(id); // a view belongs to its own menu

    // the stored tree is the `filter` of the menu's rows: both sites of the sub-region, never the one of another
    expect(await rowCodes(a, 'cw', back.body.filters.advanced as Tree)).toEqual(
      [tri1.code, tri2.code].sort(),
    );

    // an edit with If-Match keeps the history
    const upd = await a.api.call(
      'patch',
      `/saved-views/${id}`,
      { filters: { ...body.filters, layout: 'list' } },
      { 'If-Match': '"1"' },
    );
    expect(upd.status, JSON.stringify(upd.body)).toBe(200);
    expect(upd.body).toMatchObject({ version: 2, filters: { layout: 'list' } });
    const versions = await a.api.call('get', `/saved-views/${id}/versions`);
    expect(versions.body.items).toHaveLength(2);
    expect(
      (
        await a.api.call(
          'post',
          `/saved-views/${id}/deactivate`,
          {},
          { 'If-Match': '"2"' },
        )
      ).status,
    ).toBe(200);
    expect(
      idsOf(
        (await a.api.call('get', '/saved-views?screen_key=site360-cw')).body,
      ),
    ).not.toContain(id);
  });

  it('every Site Master menu and the dashboard accept a view; an unknown menu, an unknown or hidden field and a bad tree are refused', async () => {
    const a = await actor(app, db, { regions: null, grants: DASH_VIEW });
    for (const menu of [
      'master',
      'design_acq',
      'sow',
      'cw',
      'te',
      'hoto',
      'dismantle',
      'om',
    ]) {
      const res = await create(a, {
        screen_key: `site360-${menu}`,
        name: nm(`Menu ${menu}`),
        filters: { advanced: mine() },
      });
      expect(res.status, `${menu} ${JSON.stringify(res.body)}`).toBe(201);
    }
    expect(
      (
        await create(a, {
          screen_key: 'site360-nope',
          name: nm('Unknown menu'),
        })
      ).status,
    ).toBe(422);
    const bad = await create(a, {
      screen_key: 'site360-te',
      name: nm('Bad field'),
      filters: { advanced: mine(cond('no_such_field', 'is', 'x')) },
    });
    expect(bad.status).toBe(422);
    expect(bad.body.errors[0]).toMatchObject({ code: 'unknown_field' });
    // a Master column of another menu is not a field of this menu's catalogue (m:36 belongs to the procurement register: not viewable here)
    const hidden = await create(a, {
      screen_key: 'site360-master',
      name: nm('Hidden column'),
      filters: { advanced: mine(cond('m:36', 'is', 'x')) },
    });
    expect(hidden.status).toBe(422);
    expect(hidden.body.errors[0]).toMatchObject({ code: 'unknown_field' });
    const op = await create(a, {
      screen_key: 'site360-te',
      name: nm('Bad operator'),
      filters: { advanced: mine(cond('sub_region', 'contains', 'x')) },
    });
    expect(op.status).toBe(422);
    expect(op.body.errors[0]).toMatchObject({ code: 'invalid_operator' });
  });

  it('saves and loads a dashboard view with the quick parameters and the tree; the dashboard needs the Site Register right as well', async () => {
    const a = await actor(app, db, { regions: null, grants: DASH_VIEW });
    const tree = mine(cond('sub_region', 'is', `SVA-${TAG}`));
    const filters = {
      region_id: '1',
      cluster_code: '',
      scenario: 'new_build',
      stream: '',
      view: '',
      advanced: tree,
    };
    const res = await create(a, {
      screen_key: 'dashboard',
      name: nm('Tripoli dashboard'),
      filters,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      screen_key: 'dashboard',
      filters,
      is_owner: true,
    });
    const back = await a.api.call('get', `/saved-views/${res.body.id}`);
    expect(back.body.filters).toEqual(filters);
    expect(
      idsOf(
        (await a.api.call('get', '/saved-views?screen_key=dashboard')).body,
      ),
    ).toContain(res.body.id);
    // the saved tree is the `filter` of the dashboard endpoints
    expect(
      (
        await a.api.call(
          'get',
          `/dashboard?${q(back.body.filters.advanced as Tree)}`,
        )
      ).status,
    ).toBe(200);

    const dashOnly = await actor(app, db, {
      regions: null,
      grants: [['dashboard', 'view']],
    });
    expect(
      (
        await create(dashOnly, {
          screen_key: 'dashboard',
          name: nm('No sites'),
        })
      ).status,
    ).toBe(403);
    const sitesOnly = await actor(app, db, {
      regions: null,
      grants: SITES_VIEW,
    });
    expect(
      (
        await create(sitesOnly, {
          screen_key: 'dashboard',
          name: nm('No dashboard'),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await create(sitesOnly, {
          screen_key: 'site360-master',
          name: nm('Menu with sites only'),
        })
      ).status,
    ).toBe(201); // the menus need only the Site Register
  });
});

describe('the same rights model as the other saved views', () => {
  it('another user cannot read, list or change my private view; a user without the module cannot save one', async () => {
    const ann = await actor(app, db, { regions: null, grants: SITES_VIEW });
    const ben2 = await actor(app, db, { regions: null, grants: SITES_VIEW });
    const noSites = await actor(app, db, { grants: [['issues', 'view']] });
    const res = await create(ann, {
      screen_key: 'site360-sow',
      name: nm('Private'),
      filters: { layout: 'list' },
    });
    expect(res.status).toBe(201);
    const id = res.body.id as string;
    expect((await ben2.api.call('get', `/saved-views/${id}`)).status).toBe(404);
    expect(
      idsOf(
        (await ben2.api.call('get', '/saved-views?screen_key=site360-sow'))
          .body,
      ),
    ).not.toContain(id);
    expect(
      (
        await ben2.api.call(
          'patch',
          `/saved-views/${id}`,
          { name: 'hijack' },
          { 'If-Match': '"1"' },
        )
      ).status,
    ).toBe(404);
    expect(
      (await create(noSites, { screen_key: 'site360-sow', name: nm('Nope') }))
        .status,
    ).toBe(403);
    // sharing needs views.share
    expect(
      (
        await create(ann, {
          screen_key: 'site360-sow',
          name: nm('Shared by nobody'),
          audience: { user_ids: [ben2.user.id] },
        })
      ).status,
    ).toBe(403);
  });

  it('a lead shares a menu view and a dashboard view: only readers who may open the screen see them, without the audience list; only the owner changes them', async () => {
    const lead = await actor(app, db, { regions: null, grants: LEAD });
    const reader = await actor(app, db, { regions: null, grants: DASH_VIEW });
    const sitesOnly = await actor(app, db, {
      regions: null,
      grants: SITES_VIEW,
    });
    const outsider = await actor(app, db, { regions: null, grants: DASH_VIEW });
    const menu = await create(lead, {
      screen_key: 'site360-hoto',
      name: nm('HOTO late'),
      filters: { layout: 'wide', advanced: mine() },
      audience: { user_ids: [reader.user.id, sitesOnly.user.id] },
    });
    expect(menu.status, JSON.stringify(menu.body)).toBe(201);
    expect(menu.body.shared).toBe(true);
    const dash = await create(lead, {
      screen_key: 'dashboard',
      name: nm('Shared dashboard'),
      filters: { region_id: '1' },
      audience: { user_ids: [reader.user.id, sitesOnly.user.id] },
    });
    expect(dash.status, JSON.stringify(dash.body)).toBe(201);

    const m = await reader.api.call(
      'get',
      '/saved-views?screen_key=site360-hoto&scope=shared',
    );
    expect(
      m.body.items.find((x: { id: string }) => x.id === menu.body.id),
    ).toMatchObject({
      is_owner: false,
      can_edit: false,
      shared: true,
      audience: null,
      filters: { layout: 'wide' },
    });
    expect(
      idsOf(
        (
          await reader.api.call(
            'get',
            '/saved-views?screen_key=dashboard&scope=shared',
          )
        ).body,
      ),
    ).toContain(dash.body.id);
    expect(
      (
        await reader.api.call(
          'patch',
          `/saved-views/${menu.body.id}`,
          { name: 'x' },
          { 'If-Match': '"1"' },
        )
      ).status,
    ).toBe(403);
    // addressed to a user who may open the menu (the Site Register) but not the dashboard (no dashboard right): the menu view, not the dashboard view
    expect(
      idsOf(
        (
          await sitesOnly.api.call(
            'get',
            '/saved-views?screen_key=site360-hoto&scope=shared',
          )
        ).body,
      ),
    ).toContain(menu.body.id);
    expect(
      idsOf(
        (
          await sitesOnly.api.call(
            'get',
            '/saved-views?screen_key=dashboard&scope=shared',
          )
        ).body,
      ),
    ).not.toContain(dash.body.id);
    expect(
      (await sitesOnly.api.call('get', `/saved-views/${dash.body.id}`)).status,
    ).toBe(404);
    // not addressed
    expect(
      (await outsider.api.call('get', `/saved-views/${menu.body.id}`)).status,
    ).toBe(404);
  });

  it('a region-limited lead may not share a view that pins another region, on a menu or on the dashboard, and may not share with everyone', async () => {
    const lead = await actor(app, db, { regions: [1], grants: LEAD });
    const other = await actor(app, db, { regions: null, grants: SITES_VIEW });
    for (const screen of ['site360-cw', 'dashboard']) {
      expect(
        (
          await create(lead, {
            screen_key: screen,
            name: nm(`All ${screen}`),
            audience: { everyone: true },
          })
        ).status,
        screen,
      ).toBe(403);
      const out = await create(lead, {
        screen_key: screen,
        name: nm(`Zawia ${screen}`),
        filters: { region_id: '4' },
        audience: { user_ids: [other.user.id] },
      });
      expect(out.status, screen).toBe(422);
      expect(out.body.errors[0]).toMatchObject({
        path: '/filters/region_id',
        code: 'out_of_scope',
      });
      expect(
        (
          await create(lead, {
            screen_key: screen,
            name: nm(`Tripoli ${screen}`),
            filters: { region_id: '1' },
            audience: { user_ids: [other.user.id] },
          })
        ).status,
        screen,
      ).toBe(201);
    }
  });

  it('a reader never gets a condition on a field they may not use: a hidden site field and a Master column of a register they may not view are removed and counted', async () => {
    const lead = await actor(app, db, {
      regions: null,
      grants: [...LEAD, ['procurement', 'view']],
    });
    const reader = await actor(app, db, { regions: null, grants: SITES_VIEW });
    const code = `sv_secret_${TAG.toLowerCase()}`;
    const f = await db.query(
      `INSERT INTO field_definitions (entity_type, code, label_en, data_type, in_list_filters) VALUES ('site', $1, 'Secret', 'text', true) RETURNING id`,
      [code],
    );
    await db.query(
      `INSERT INTO field_permissions (field_id, role_id, access) VALUES ($1, $2, 'hidden')`,
      [f.rows[0].id, reader.roleId],
    );
    const tree = mine(
      cond(`c:${code}`, 'is', 'gold'),
      cond('m:36', 'is', 'someone'),
      cond('sub_region', 'is', `SVA-${TAG}`),
    );
    const res = await create(lead, {
      screen_key: 'site360-master',
      name: nm('With hidden'),
      filters: { advanced: tree },
      audience: { user_ids: [reader.user.id] },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.stripped_columns).toBe(0); // the owner sees all of it
    const seen = await reader.api.call('get', `/saved-views/${res.body.id}`);
    expect(seen.status).toBe(200);
    const fields = (
      seen.body.filters.advanced.items as { field: string }[]
    ).map((c) => c.field);
    expect(fields).toEqual(['site_code', 'sub_region']);
    expect(seen.body.stripped_columns).toBe(2);
    const list = await reader.api.call(
      'get',
      '/saved-views?screen_key=site360-master&scope=shared',
    );
    const row = list.body.items.find(
      (x: { id: string }) => x.id === res.body.id,
    );
    expect(row.stripped_columns).toBe(2);
    expect(JSON.stringify(row.filters)).not.toContain(code);
    expect(JSON.stringify(row.filters)).not.toContain('m:36');
  });
});

describe('GET /saved-views/filter-fields/{field}/values', () => {
  it('searches the distinct values of the data anywhere in the value, case-insensitively, without wildcards, with a limit and truncated', async () => {
    const a = await actor(app, db, { regions: null, grants: DASH_VIEW });
    for (const screen of [
      'sites',
      'site360-master',
      'site360-cw',
      'dashboard',
    ]) {
      const both = await values(
        a,
        screen,
        'sub_region',
        `q=${TAG.toLowerCase()}`,
      );
      expect(both.status, `${screen} ${JSON.stringify(both.body)}`).toBe(200);
      expect(valueList(both.body)).toEqual([`SVA-${TAG}`, `SVB-${TAG}`]); // sorted, each once (two sites hold SVA)
      expect(both.body).toMatchObject({
        screen_key: screen,
        field: 'sub_region',
        q: TAG.toLowerCase(),
        truncated: false,
      });
      expect(
        valueList((await values(a, screen, 'sub_region', `q=svb-${TAG}`)).body),
      ).toEqual([`SVB-${TAG}`]);
      expect(
        valueList(
          (
            await values(
              a,
              screen,
              'sub_region',
              `q=${encodeURIComponent('%')}`,
            )
          ).body,
        ),
      ).toEqual([]); // no wildcard: a % matches only a % in the value
      expect(
        valueList(
          (
            await values(
              a,
              screen,
              'sub_region',
              `q=${encodeURIComponent(`SVA-${TAG}x`)}`,
            )
          ).body,
        ),
      ).toEqual([]);
    }
    const one = await values(a, 'sites', 'sub_region', `q=${TAG}&limit=1`);
    expect(valueList(one.body)).toEqual([`SVA-${TAG}`]);
    expect(one.body.truncated).toBe(true);
    // no q: the first values, never more than the limit (default 50)
    const first = await values(a, 'sites', 'sub_region');
    expect(first.status).toBe(200);
    expect(first.body.items.length).toBeLessThanOrEqual(50);
    const some = await values(a, 'sites', 'sub_region', 'limit=3');
    expect(some.body.items.length).toBeLessThanOrEqual(3);
  });

  it('keeps the scope of the caller: a Tripoli reader never gets a Benghazi value', async () => {
    const tripoli = await actor(app, db, { regions: [1], grants: SITES_VIEW });
    const res = await values(
      tripoli,
      'site360-master',
      'sub_region',
      `q=${TAG}`,
    );
    expect(res.status).toBe(200);
    expect(valueList(res.body)).toEqual([`SVA-${TAG}`]);
    // the regions are a fixed list: searched by label, in English
    const regions = await values(tripoli, 'sites', 'region_id', 'q=tripoli');
    expect(regions.status).toBe(200);
    expect(valueList(regions.body)).toContain('1');
    expect(regions.body.truncated).toBe(false);
  });

  it('searches a list field by code or label, and a field a field rule hides is unknown to the reader', async () => {
    const lead = await actor(app, db, { regions: null, grants: DASH_VIEW });
    const reader = await actor(app, db, { regions: null, grants: DASH_VIEW });
    const code = `sv_list_${TAG.toLowerCase()}`;
    const f = await db.query(
      `INSERT INTO field_definitions (entity_type, code, label_en, data_type, in_list_filters) VALUES ('site', $1, 'Pick', 'list', true) RETURNING id`,
      [code],
    );
    await db.query(
      `INSERT INTO field_permissions (field_id, role_id, access) VALUES ($1, $2, 'hidden')`,
      [f.rows[0].id, reader.roleId],
    );
    await db.query(
      `INSERT INTO field_list_values (field_id, code, label_en, label_ar, sort_order) VALUES ($1, $2, 'Alpha one', NULL, 1), ($1, $3, 'Beta two', NULL, 2), ($1, $4, 'Gamma', NULL, 3)`,
      [f.rows[0].id, `ALPHA-${TAG}`, `BETA-${TAG}`, `GAMMA-${TAG}`],
    );
    await db.query(
      `UPDATE field_list_values SET is_active = false WHERE field_id = $1 AND code = $2`,
      [f.rows[0].id, `GAMMA-${TAG}`],
    );
    for (const screen of ['sites', 'site360-te', 'dashboard']) {
      const key = `c:${code}`;
      const byLabel = await values(lead, screen, key, 'q=beta');
      expect(byLabel.status, `${screen} ${JSON.stringify(byLabel.body)}`).toBe(
        200,
      );
      expect(byLabel.body.items).toEqual([
        { value: `BETA-${TAG}`, label_en: 'Beta two' },
      ]);
      expect(
        valueList(
          (await values(lead, screen, key, `q=${TAG.toLowerCase()}`)).body,
        ),
      ).toEqual([`ALPHA-${TAG}`, `BETA-${TAG}`]); // the inactive value is not offered
      const seen = await values(reader, screen, key, 'q=beta');
      expect(seen.status, screen).toBe(422);
      expect(seen.body.errors[0]).toMatchObject({ code: 'unknown_field' });
      expect(JSON.stringify(seen.body)).not.toContain(`BETA-${TAG}`);
    }
  });

  it('answers 422 for an unknown field, a field with no list and bad parameters, and 403 without the right on the screen', async () => {
    const a = await actor(app, db, { regions: null, grants: DASH_VIEW });
    const unknown = await values(a, 'sites', 'no_such_field', 'q=x');
    expect(unknown.status).toBe(422);
    expect(unknown.body.errors[0]).toMatchObject({
      path: '/field',
      code: 'unknown_field',
    });
    const text = await values(a, 'sites', 'name', 'q=x'); // a text field has no list of values
    expect(text.status).toBe(422);
    expect(text.body.errors[0]).toMatchObject({ code: 'not_enum' });
    // a Master column of another menu is unknown on this one
    expect((await values(a, 'site360-cw', 'm:1', 'q=x')).status).toBe(422);
    expect((await values(a, 'audit-log', 'sub_region', 'q=x')).status).toBe(
      422,
    );
    expect((await values(a, 'not-a-screen', 'sub_region', 'q=x')).status).toBe(
      422,
    );
    for (const bad of [
      'limit=0',
      'limit=501',
      'limit=abc',
      `q=${'x'.repeat(101)}`,
    ]) {
      const res = await values(a, 'sites', 'sub_region', bad);
      expect(res.status, bad).toBe(422);
    }
    expect((await values(a, 'sites', 'sub_region', 'limit=500')).status).toBe(
      200,
    );
    const none = await actor(app, db, { grants: [['issues', 'view']] });
    for (const screen of ['sites', 'site360-master', 'dashboard'])
      expect(
        (await values(none, screen, 'sub_region', 'q=x')).status,
        screen,
      ).toBe(403);
    const dashOnly = await actor(app, db, {
      regions: null,
      grants: [['dashboard', 'view']],
    });
    expect(
      (await values(dashOnly, 'dashboard', 'sub_region', 'q=x')).status,
    ).toBe(403); // the dashboard filter also needs the Site Register right
  });
});

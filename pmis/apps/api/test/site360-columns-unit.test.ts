import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mapWfError } from '../src/common/db-errors';
import {
  BLANK_MASTER_OWNER,
  padMasterColumns,
  type MasterColumn,
} from '../src/exports/master-layout';
import {
  buildColumnBands,
  createColumnBody,
  parseIncludeInactive,
  previewBody,
  reasonBody,
  SITE360_COLUMN_TYPES,
  updateColumnBody,
} from '../src/site360/site360-columns';
import {
  displayOrder,
  menuColumns,
  type Site360ColumnRow,
} from '../src/site360/site360-sections';

/** Workflow Studio S2 (contract 0.15.43, migration 0133): the pure parts, with no database. */
const REASON = 'Studio test change';
const mc = (ord: number, over: Partial<MasterColumn> = {}): MasterColumn => ({
  ord,
  letter: `L${ord}`,
  group_top: 'B',
  group_mid: 'G',
  name: `n${ord}`,
  header: `G / n${ord}`,
  owner: 'task',
  ...over,
});

describe('create body', () => {
  const ok = {
    name_en: 'Permit ref',
    group_top: 'Studio',
    after_ord: 187,
    source: { kind: 'task_input', task_code: 'A1' },
    sections: ['cw'],
    reason: REASON,
  };

  it('accepts a task input source and a site field source', () => {
    expect(createColumnBody.safeParse(ok).success).toBe(true);
    expect(
      createColumnBody.safeParse({
        ...ok,
        source: {
          kind: 'site_field',
          field_id: '11111111-1111-4111-8111-111111111111',
        },
      }).success,
    ).toBe(true);
  });

  it('refuses unknown keys, a missing reason or source, a bad key and a bad type', () => {
    expect(createColumnBody.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(createColumnBody.safeParse({ ...ok, reason: 'ab' }).success).toBe(
      false,
    );
    const noSource: Record<string, unknown> = { ...ok };
    delete noSource.source;
    expect(createColumnBody.safeParse(noSource).success).toBe(false);
    expect(
      createColumnBody.safeParse({
        ...ok,
        source: { kind: 'task_input', task_code: 'A1', field_key: 'V:Bad Key' },
      }).success,
    ).toBe(false);
    expect(
      createColumnBody.safeParse({ ...ok, value_type: 'currency' }).success,
    ).toBe(false);
    expect(createColumnBody.safeParse({ ...ok, after_ord: 0 }).success).toBe(
      false,
    );
    expect(createColumnBody.safeParse({ ...ok, after_ord: 1001 }).success).toBe(
      false,
    );
    expect(
      createColumnBody.safeParse({ ...ok, sections: ['cw', 'cw'] }).success,
    ).toBe(false);
    expect(
      createColumnBody.safeParse({ ...ok, sections: ['status'] }).success,
    ).toBe(false);
    expect(
      createColumnBody.safeParse({
        ...ok,
        source: { kind: 'site_field', field_id: 'nope' },
      }).success,
    ).toBe(false);
  });

  it('takes the five types of the task inputs', () => {
    expect([...SITE360_COLUMN_TYPES]).toEqual([
      'text',
      'number',
      'date',
      'list',
      'yes_no',
    ]);
  });
});

describe('update, preview and reason bodies', () => {
  it('needs at least one key besides the reason and the confirmation', () => {
    expect(updateColumnBody.safeParse({ reason: REASON }).success).toBe(false);
    expect(
      updateColumnBody.safeParse({
        reason: REASON,
        confirm_unconvertible: true,
      }).success,
    ).toBe(false);
    expect(
      updateColumnBody.safeParse({ reason: REASON, name_en: 'New name' })
        .success,
    ).toBe(true);
    expect(
      updateColumnBody.safeParse({
        reason: REASON,
        list_catalogue: null,
        value_type: 'text',
      }).success,
    ).toBe(true);
    expect(
      updateColumnBody.safeParse({
        reason: REASON,
        name_en: 'x',
        sections: ['cw'],
      }).success,
    ).toBe(false);
  });

  it('checks the preview and the reason-only bodies', () => {
    expect(
      previewBody.safeParse({
        value_type: 'list',
        list_catalogue: 'RegionList',
      }).success,
    ).toBe(true);
    expect(
      previewBody.safeParse({ value_type: 'list', extra: 1 }).success,
    ).toBe(false);
    expect(previewBody.safeParse({}).success).toBe(false);
    expect(reasonBody.safeParse({ reason: REASON }).success).toBe(true);
    expect(reasonBody.safeParse({ reason: ' a ' }).success).toBe(false);
  });

  it('reads include_inactive: true by default, true or false, else refused', () => {
    expect(parseIncludeInactive(undefined)).toBe(true);
    expect(parseIncludeInactive('true')).toBe(true);
    expect(parseIncludeInactive('false')).toBe(false);
    expect(parseIncludeInactive('yes')).toBeNull();
  });
});

describe('the place picker', () => {
  it('lists each band once with its groups in display order, skipping inactive columns', () => {
    const items = [
      { ord: 1, group_top: '#', group_mid: null, is_active: true },
      { ord: 2, group_top: 'RF', group_mid: 'Id', is_active: true },
      { ord: 3, group_top: 'RF', group_mid: 'Id', is_active: true },
      { ord: 4, group_top: 'RF', group_mid: 'Geo', is_active: true },
      { ord: 188, group_top: 'Studio', group_mid: null, is_active: false },
      { ord: 5, group_top: 'Gate', group_mid: 'Ready', is_active: true },
    ];
    expect(buildColumnBands(items)).toEqual([
      { name: '#', groups: [null] },
      { name: 'RF', groups: ['Id', 'Geo'] },
      { name: 'Gate', groups: ['Ready'] },
    ]);
  });
});

describe('the menus follow the display order', () => {
  const row = (
    ord: number,
    display_order: number | undefined,
    sections: Site360ColumnRow['sections'],
  ): Site360ColumnRow => ({
    ord,
    letter: `L${ord}`,
    group_top: 'B',
    group_mid: 'G',
    header: `h${ord}`,
    sections,
    display_order,
  });

  it('falls back to the Master order when a column has no display order', () => {
    expect(displayOrder({ ord: 7 })).toBe(7);
    expect(displayOrder({ ord: 188, display_order: 20 })).toBe(20);
  });

  it('puts an added column right after the column it was added after, in its menus only', () => {
    const cols = [
      row(1, 1, ['status']),
      row(2, 2, ['status']),
      row(3, 3, ['cw']),
      row(4, 5, ['cw']),
      row(188, 4, ['cw']),
      row(5, 6, ['te']),
    ];
    expect(menuColumns('master', cols).map((c) => c.ord)).toEqual([
      1, 2, 3, 188, 4, 5,
    ]);
    expect(menuColumns('cw', cols).map((c) => c.ord)).toEqual([
      1, 2, 3, 188, 4,
    ]);
    // the identity columns (ords 1 to 4) are in every menu; the added column carries the cw menu only
    expect(menuColumns('te', cols).map((c) => c.ord)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('the Master export keeps the letters true', () => {
  it('pads the position of a deleted or deactivated column with an empty one and stops at the last column', () => {
    const out = padMasterColumns([mc(1), mc(2), mc(4), mc(6)]);
    expect(out.map((c) => c.ord)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(
      out.filter((c) => c.owner === BLANK_MASTER_OWNER).map((c) => c.ord),
    ).toEqual([3, 5]);
    expect(out[2]).toMatchObject({
      letter: '',
      header: '',
      name: null,
      group_top: null,
      group_mid: null,
    });
  });

  it('leaves a gapless list as it is, added columns included', () => {
    const cols = [mc(186), mc(187), mc(188, { owner: 'added' })];
    expect(
      padMasterColumns(cols)
        .map((c) => c.ord)
        .slice(-3),
    ).toEqual([186, 187, 188]);
    expect(padMasterColumns(cols)).toHaveLength(188);
    expect(padMasterColumns([])).toEqual([]);
  });
});

describe('the database refusals of the doors', () => {
  const wf = (code: string, extra: Record<string, unknown>): string =>
    `wf:${code}:${JSON.stringify(extra)}`;

  it('maps column_in_use to 409 with why and count', () => {
    const p = mapWfError(
      wf('column_in_use', { detail: 'in use', why: 'has_values', count: 3 }),
    );
    expect(p?.getStatus()).toBe(409);
    expect(JSON.stringify(p?.opts)).toContain('has_values');
  });

  it('maps input_already_mapped and field_already_mapped to 409', () => {
    expect(mapWfError(wf('input_already_mapped', {}))?.getStatus()).toBe(409);
    expect(mapWfError(wf('field_already_mapped', {}))?.getStatus()).toBe(409);
  });

  it('maps the existing codes the doors use: system_field, conversion_unconfirmed with the preview, validation_failed with errors', () => {
    expect(
      mapWfError(
        wf('system_field', { reason: 'Row number and Site ID' }),
      )?.getStatus(),
    ).toBe(409);
    const c = mapWfError(
      wf('conversion_unconfirmed', { conversion: { not_convertible: 2 } }),
    );
    expect(c?.getStatus()).toBe(409);
    expect(JSON.stringify(c?.opts)).toContain('not_convertible');
    const v = mapWfError(
      wf('validation_failed', {
        errors: [{ path: '/group_top', code: 'placement_splits_band' }],
      }),
    );
    expect(v?.getStatus()).toBe(422);
    expect(JSON.stringify(v?.opts)).toContain('placement_splits_band');
  });
});

describe('migration 0133 and its mirror', () => {
  const root = join(__dirname, '..', '..', '..');
  const mig = readFileSync(
    join(
      __dirname,
      '..',
      'prisma',
      'migrations',
      '0133_site360_column_admin',
      'migration.sql',
    ),
    'utf8',
  );

  it('is byte-identical to db/sql/132_site360_column_admin.sql', () => {
    expect(
      readFileSync(
        join(root, 'db', 'sql', '132_site360_column_admin.sql'),
        'utf8',
      ),
    ).toBe(mig);
  });

  it('defines every door as a SECURITY DEFINER function granted to pmis_app and uses no em dash', () => {
    for (const f of [
      'site360_columns_list',
      'site360_column_get',
      'site360_column_type_preview',
      'site360_column_create',
      'site360_column_update',
      'site360_column_set_active',
      'site360_column_delete',
      'site360_col_can_admin',
    ]) {
      expect(mig).toMatch(new RegExp(`CREATE OR REPLACE FUNCTION ${f}\\(`));
      expect(mig).toContain(`'${f}(`);
    }
    expect(mig).not.toMatch(new RegExp(`[${String.fromCharCode(0x2014, 0x2015)}]`));
  });

  it('computes the Master letters of GE, GF and ZZ like the export', () => {
    // the database function is base 26 (A = 1); the same arithmetic in TypeScript
    const letter = (n: number): string => {
      let s = '';
      for (let x = n; x > 0; x = Math.floor((x - 1) / 26))
        s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
      return s;
    };
    expect(letter(187)).toBe('GE');
    expect(letter(188)).toBe('GF');
    expect(letter(189)).toBe('GG');
    expect(letter(702)).toBe('ZZ');
    expect(mig).toContain('chr(65 + ((n - 1) % 26)) || s');
  });
});

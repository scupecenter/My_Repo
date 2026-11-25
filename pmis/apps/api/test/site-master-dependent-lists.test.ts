import { describe, expect, it } from 'vitest';
import { attachParentOrds, cellInput } from '../src/site-master/site-master.service';

/** Dependent lists (0.15.50): a child list cell names the column that holds its parent value; each option names its parent value. */
describe('attachParentOrds', () => {
  const tasks = [
    { site_id: 's1', ord: 40, list_catalogue: 'REGION_LIST' },
    { site_id: 's1', ord: 41, list_catalogue: 'CITY_LIST' },
    { site_id: 's1', ord: 42, list_catalogue: null },
    { site_id: 's2', ord: 41, list_catalogue: 'CITY_LIST' }, // this site has no cell of the parent list in the menu
  ];
  const fresh = () => new Map<string, Record<string, { parent_ord?: number }>>([
    ['s1', { '40': {}, '41': {}, '42': {} }],
    ['s2', { '41': {} }],
  ]);
  const parents = new Map([['CITY_LIST', 'REGION_LIST']]);

  it('links the child cell to the parent cell of the same site only', () => {
    const cells = fresh();
    attachParentOrds(tasks, cells, parents);
    expect(cells.get('s1')!['41']).toEqual({ parent_ord: 40 });
    expect(cells.get('s1')!['40']).toEqual({});
    expect(cells.get('s1')!['42']).toEqual({});
    expect(cells.get('s2')!['41']).toEqual({}); // no parent column in this site's cells: the client offers every option
  });

  it('does nothing when no list has a parent', () => {
    const cells = fresh();
    attachParentOrds(tasks, cells, new Map());
    expect(cells.get('s1')!['41']).toEqual({});
  });
});

describe('cellInput with dependent options', () => {
  it('keeps the parent code of each option', () => {
    const opts = [{ value: 'TIP', label_en: 'Tripoli', label_ar: null, parent: 'WEST' }, { value: 'BNG', label_en: 'Benghazi', label_ar: null, parent: 'EAST' }];
    expect(cellInput('v:city', 'list', null, opts)).toEqual({ input_type: 'list', options: opts });
  });
});

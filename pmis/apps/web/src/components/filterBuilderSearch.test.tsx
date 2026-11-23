import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { API_BASE } from '@/api/client';
import type { FilterField, FilterTree } from '@/api/views';
import { server } from '@/mocks/server';
import { renderApp, signIn } from '@/test/utils';
import { FilterTreeEditor } from './FilterBuilder';

/** The AND/OR builder uses the same server value search as the unified filter for a truncated enum field (0.15.49), through the shared ChoiceList. */
const FIELD = {
  key: 'sub_region', label_en: 'Sub-region', label_ar: null, type: 'enum', group: { key: 'site', label_en: 'Site', label_ar: null },
  operators: ['in', 'not_in', 'is', 'empty'], truncated: true,
  options: [{ value: 'AAA-1', label_en: 'AAA-1' }, { value: 'AAA-2', label_en: 'AAA-2' }],
} as unknown as FilterField;

function Host({ screenKey, onTree }: { screenKey?: string; onTree: (t: FilterTree) => void }) {
  const [tree, setTree] = useState<FilterTree>({ op: 'and', items: [{ field: 'sub_region', operator: 'in', value: ['AAA-1'] }] });
  return <FilterTreeEditor tree={tree} fields={[FIELD]} screen={screenKey} onChange={(t) => { setTree(t); onTree(t); }} />;
}

describe('FilterTreeEditor: server value search', () => {
  it('asks the server (debounced) for a truncated field, lists what it finds and adds a value that was not in the first list', async () => {
    await signIn('pm');
    const asked: { field: string; q: string; screen: string }[] = [];
    server.use(
      http.get(`${API_BASE}/saved-views/filter-fields/:field/values`, ({ request, params }) => {
        const u = new URL(request.url);
        asked.push({ field: decodeURIComponent(String(params.field)), q: u.searchParams.get('q') ?? '', screen: u.searchParams.get('screen_key') ?? '' });
        return HttpResponse.json({ screen_key: 'sites', field: 'sub_region', q: u.searchParams.get('q'), truncated: false, items: [{ value: 'ZETA-9', label_en: 'ZETA-9 (far)' }] });
      }),
    );
    let last: FilterTree | null = null;
    const u = userEvent.setup();
    renderApp(<Host screenKey="sites" onTree={(t) => { last = t; }} />);
    expect(await screen.findByTestId('filter-cond-0-choice-truncated')).toBeInTheDocument();
    expect(screen.getByTestId('filter-cond-0-choice-opt-AAA-2')).toBeInTheDocument();
    expect(asked).toEqual([]); // nothing is asked while the search box is empty
    await u.type(screen.getByTestId('filter-cond-0-choice-search'), 'zeta');
    const found = await screen.findByTestId('filter-cond-0-choice-opt-ZETA-9');
    expect(found).toHaveTextContent('ZETA-9 (far)');
    expect(asked).toEqual([{ field: 'sub_region', q: 'zeta', screen: 'sites' }]); // four keystrokes, one request
    await u.click(found);
    await waitFor(() => expect(last?.items[0]).toMatchObject({ field: 'sub_region', operator: 'in', value: ['AAA-1', 'ZETA-9'] }));
    // the value already chosen stays on the list while the search changes
    expect(screen.getByTestId('filter-cond-0-choice-opt-AAA-1')).toBeInTheDocument();
  }, 30_000);

  it('keeps the plain select when no screen is given', async () => {
    await signIn('pm');
    renderApp(<Host onTree={() => undefined} />);
    expect(await screen.findByTestId('filter-cond-0-value')).toHaveProperty('tagName', 'SELECT');
    expect(screen.queryByTestId('filter-cond-0-choice-search')).toBeNull();
  });
});

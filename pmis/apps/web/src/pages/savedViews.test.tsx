import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { API_BASE } from '@/api/client';
import { DraftBar, useDraft } from '@/components/DraftBar';
import { legacyKey } from '@/components/SavedViews';
import { server } from '@/mocks/server';
import { renderApp, signIn } from '@/test/utils';
import { AuditLog } from './logs/AuditLog';
import { Sites } from './Sites';

/** P10 (contract 0.12.12, owner answers Q115 and Q117): saved views on the server for every list screen, sharing, and server-side drafts. */
const options = () => within(screen.getByTestId('views-select')).getAllByRole('option').map((o) => o.textContent);

describe('saved views on the list screens', () => {
  it('saves the filters and the columns of the Site Register, and applies both again', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<Sites />, { route: '/sites?region_id=1' });
    await screen.findByTestId('sites-list');
    await u.click(screen.getByTestId('cols-menu'));
    await u.click(screen.getByTestId('col-toggle-scenario'));
    await waitFor(() => expect(screen.queryByRole('columnheader', { name: /Scenario/ })).toBeNull());
    await u.keyboard('{Escape}');
    await u.click(screen.getByTestId('views-save'));
    await u.type(screen.getByTestId('views-name'), 'Tripoli lean');
    await u.click(screen.getByTestId('views-name-ok'));
    await waitFor(() => expect(options()).toContain('Tripoli lean'));

    await u.click(screen.getByTestId('chips-clear'));
    await u.click(screen.getByTestId('cols-menu'));
    await u.click(screen.getByTestId('cols-reset'));
    expect(await screen.findByRole('columnheader', { name: /Scenario/ })).toBeInTheDocument();
    await u.keyboard('{Escape}');
    await u.selectOptions(screen.getByTestId('views-select'), screen.getByRole('option', { name: 'Tripoli lean' }));
    await waitFor(() => expect(screen.getByTestId('sites-filter-region')).toHaveValue('1'));
    await waitFor(() => expect(screen.queryByRole('columnheader', { name: /Scenario/ })).toBeNull());
  });

  it('keeps a private view to its owner; a shared one reaches the others, read-only', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    const first = renderApp(<AuditLog />);
    await screen.findAllByTestId(/^audit-table-row-/);
    await u.click(screen.getByTestId('views-save'));
    await u.type(screen.getByTestId('views-name'), 'Only mine');
    await u.click(screen.getByTestId('views-name-ok'));
    await u.click(screen.getByTestId('views-save'));
    await u.type(screen.getByTestId('views-name'), 'For all');
    await u.click(screen.getByTestId('views-name-ok'));
    await waitFor(() => expect(options()).toContain('For all'));
    await u.selectOptions(screen.getByTestId('views-select'), screen.getByRole('option', { name: /For all/ }));
    await u.click(screen.getByTestId('views-share'));
    const dlg = await screen.findByTestId('views-share-dialog');
    await u.click(within(dlg).getByTestId('views-share-everyone'));
    await u.click(within(dlg).getByTestId('views-share-dialog-submit'));
    await waitFor(() => expect(screen.queryByTestId('views-share-dialog')).toBeNull());
    await waitFor(() => expect(options()).toContain('For all · shared'));
    first.unmount();

    await signIn('reviewer');
    renderApp(<AuditLog />);
    await waitFor(() => expect(options()).toContain('For all · Ahmed Salem'));
    expect(options().some((o) => o?.includes('Only mine'))).toBe(false);
    await u.selectOptions(screen.getByTestId('views-select'), screen.getByRole('option', { name: /For all/ }));
    expect(screen.queryByTestId('views-update')).toBeNull();
    expect(screen.queryByTestId('views-delete')).toBeNull();
  });

  it('a user without views.share cannot share (no share button, and the server refuses)', async () => {
    await signIn('engineer');
    const u = userEvent.setup();
    renderApp(<Sites />, { route: '/sites' });
    await screen.findByTestId('sites-list');
    await u.click(screen.getByTestId('views-save'));
    await u.type(screen.getByTestId('views-name'), 'Mine');
    await u.click(screen.getByTestId('views-name-ok'));
    await waitFor(() => expect(options()).toContain('Mine'));
    await u.selectOptions(screen.getByTestId('views-select'), screen.getByRole('option', { name: 'Mine' }));
    expect(screen.queryByTestId('views-share')).toBeNull();
    expect(screen.getByTestId('views-delete')).toBeInTheDocument();
  });

  it('moves the views this browser kept locally to the server on first use, then forgets them locally', async () => {
    await signIn('pm');
    localStorage.setItem(legacyKey('audit-log'), JSON.stringify([{ id: 'l1', name: 'Old local', filter: { via: 'api' } }]));
    let imported = 0;
    server.events.on('request:start', ({ request }) => { if (request.url.endsWith('/saved-views/import')) imported += 1; });
    renderApp(<AuditLog />);
    await waitFor(() => expect(options()).toContain('Old local'));
    expect(localStorage.getItem(legacyKey('audit-log'))).toBeNull();
    expect(imported).toBe(1);
    server.events.removeAllListeners();
  });

  it('shows how many hidden columns the server left out', async () => {
    await signIn('pm');
    server.use(http.get(`${API_BASE}/saved-views`, () => HttpResponse.json({
      can_share: 'none', can_manage: false,
      items: [{ id: '5a000000-0000-4000-8000-000000000001', screen_key: 'audit-log', name: 'Lead view', filters: {}, columns: {}, sort: [], stripped_columns: 2, owner: { id: '5a000000-0000-4000-8000-000000000002', display_name: 'Mona Fathi' }, owner_left: true, is_owner: false, shared: true, audience: null, can_edit: false, can_share: false, is_active: true, version: 3, imported: false, created_at: '2026-11-01T08:00:00Z', updated_at: '2026-11-01T08:00:00Z' }],
    })));
    const u = userEvent.setup();
    renderApp(<AuditLog />);
    await waitFor(() => expect(options()).toContain('Lead view · Mona Fathi'));
    await u.selectOptions(screen.getByTestId('views-select'), screen.getByRole('option', { name: /Lead view/ }));
    expect(screen.getByTestId('views-stripped')).toHaveTextContent('2 hidden columns left out');
    expect(screen.getByTestId('views-owner-left')).toBeInTheDocument();
  });

  it('is in Arabic too', async () => {
    await signIn('pm');
    renderApp(<AuditLog />, { locale: 'ar' });
    await waitFor(() => expect(screen.getByTestId('views-save')).toHaveTextContent('حفظ العرض'));
    expect(options()[0]).toBe('العرض الافتراضي');
  });
});

function Form({ k }: { k: string }) {
  const [v, setV] = useState({ note: '' });
  const d = useDraft(k, v, v.note !== '');
  return (
    <div>
      <input data-testid="note" value={v.note} onChange={(e) => setV({ note: e.target.value })} />
      <DraftBar draft={d} onRestore={(x) => setV({ note: String(x.note ?? '') })} />
      <button type="button" data-testid="really-save" onClick={d.clear}>save</button>
    </div>
  );
}

describe('server-side drafts (Q115)', () => {
  it('autosaves unsaved input on the server, never in localStorage, and offers to restore it', async () => {
    await signIn('engineer');
    const u = userEvent.setup();
    const first = renderApp(<Form k="form.test" />);
    await u.type(screen.getByTestId('note'), 'half typed');
    expect(await screen.findByTestId('draft-saved', {}, { timeout: 4000 })).toHaveTextContent('Draft saved');
    expect(JSON.stringify({ ...localStorage })).not.toContain('half typed');
    first.unmount();

    renderApp(<Form k="form.test" />);
    expect(await screen.findByTestId('draft-offer')).toBeInTheDocument();
    await u.click(screen.getByTestId('draft-restore'));
    expect(screen.getByTestId('note')).toHaveValue('half typed');
    await u.click(screen.getByTestId('really-save'));
  });

  it('a draft belongs to its user only', async () => {
    await signIn('engineer');
    const u = userEvent.setup();
    const first = renderApp(<Form k="form.mine" />);
    await u.type(screen.getByTestId('note'), 'private');
    await screen.findByTestId('draft-saved', {}, { timeout: 4000 });
    first.unmount();
    await signIn('reviewer');
    renderApp(<Form k="form.mine" />);
    await new Promise((r) => setTimeout(r, 200));
    expect(screen.queryByTestId('draft-offer')).toBeNull();
  });

  it('discarding the offered draft removes it on the server', async () => {
    await signIn('engineer');
    const u = userEvent.setup();
    const first = renderApp(<Form k="form.gone" />);
    await u.type(screen.getByTestId('note'), 'x');
    await screen.findByTestId('draft-saved', {}, { timeout: 4000 });
    first.unmount();
    const second = renderApp(<Form k="form.gone" />);
    await u.click(await screen.findByTestId('draft-discard'));
    await waitFor(() => expect(screen.queryByTestId('draft-offer')).toBeNull());
    second.unmount();
    renderApp(<Form k="form.gone" />);
    await new Promise((r) => setTimeout(r, 200));
    expect(screen.queryByTestId('draft-offer')).toBeNull();
  });
});

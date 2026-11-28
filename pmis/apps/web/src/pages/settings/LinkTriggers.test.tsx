import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import en from '@/i18n/en.json';
import ar from '@/i18n/ar.json';
import { renderApp, signIn } from '@/test/utils';
import { LinkProposals } from '../LinkProposals';
import { SettingsRoutes } from './Settings';

/** 0.15.488 (migration 0629): link triggers propose, never write. */
describe('Link triggers (0.15.488)', () => {
  it('adds a trigger that starts switched off, then shows the dry run without writing', async () => {
    const u = userEvent.setup();
    await signIn('pm');
    renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/alerts/triggers' });
    await screen.findByTestId('link-triggers');
    expect(screen.getByTestId('lt-empty')).toBeInTheDocument();
    await u.selectOptions(await screen.findByTestId('lt-link'), 'invoices.procurement_record_id');
    await u.selectOptions(screen.getByTestId('lt-src'), 'due_date');
    const dst = screen.getByTestId('lt-dst');
    expect(Array.from(dst.querySelectorAll('option')).map((o) => o.textContent)).not.toContain('stage (list)');
    await u.selectOptions(dst, 'delivery_date');
    expect(screen.getByTestId('lt-add')).toBeDisabled();
    await u.type(screen.getByTestId('lt-reason'), 'keep dates in step');
    await u.click(screen.getByTestId('lt-add'));
    const row = await screen.findByTestId(/^lt-row-/);
    const box = row.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(box.checked).toBe(false);
    await u.click(row.querySelector('[data-testid^="lt-preview-"]') as HTMLElement);
    expect(await screen.findByTestId(/^lt-preview-result-/)).toHaveTextContent('1');
  }, 30_000);

  it('lists the open proposals and closes one by dismissing it', async () => {
    const u = userEvent.setup();
    await signIn('pm');
    renderApp(<Routes><Route path="/link-proposals" element={<LinkProposals />} /></Routes>, { route: '/link-proposals' });
    const first = await screen.findByTestId('lp-row-00000000-0000-4000-8000-00000000b001');
    expect(first).toHaveTextContent('PO-001');
    await u.click(screen.getByTestId('lp-dismiss-00000000-0000-4000-8000-00000000b001'));
    await waitFor(() => expect(screen.queryByTestId('lp-row-00000000-0000-4000-8000-00000000b001')).toBeNull());
    await u.click(screen.getByTestId('lp-apply-00000000-0000-4000-8000-00000000b002'));
    await waitFor(() => expect(screen.getByTestId('lp-empty')).toBeInTheDocument());
  }, 30_000);

  it('has English and Arabic wording', () => {
    for (const k of ['title', 'intro', 'empty', 'dry_run', 'add']) {
      expect((en.linkTriggers as Record<string, string>)[k]).toBeTruthy();
      expect((ar.linkTriggers as Record<string, string>)[k]).toBeTruthy();
    }
    expect(ar.linkProposals.apply).toBeTruthy();
  });
});

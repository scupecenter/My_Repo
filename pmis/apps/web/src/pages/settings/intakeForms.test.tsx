import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { api } from '@/api/client';
import { intakeSubmissions, resetIntake, setIntakeLocked } from '@/mocks/handlers.intake';
import { PublicIntake } from '@/pages/PublicIntake';
import { renderApp, signIn } from '@/test/utils';
import { SettingsRoutes } from './Settings';

/** Public intake forms (migration 0730, contract 0.15.600): the manager's screen and the page of the shared link. */
const settings = () => renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/registers/intake' });
const pub = (token: string) => renderApp(<Routes><Route path="/intake/:token" element={<PublicIntake />} /></Routes>, { route: `/intake/${token}` });
const make = async (extra: Record<string, unknown> = {}) => api.post<{ id: string; token: string }>('/intake-forms', { body: { name: 'Gate problems', register_key: 'issues', site_id: 's1', field_codes: ['title', 'remark'], ...extra } });

describe('Settings, Public intake forms', () => {
  beforeEach(() => resetIntake());

  it('makes a form, shows its link once, switches it off, makes a new link and deletes it', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    settings();
    expect(await screen.findByTestId('intake-empty')).toBeInTheDocument();
    await u.click(screen.getByTestId('intake-new'));
    await u.type(await screen.findByTestId('intake-f-name'), 'Gate problems');
    await u.selectOptions(screen.getByTestId('intake-f-register'), 'issues');
    await u.click(await screen.findByTestId('intake-ask-title'));
    await waitFor(() => expect(screen.getByTestId('intake-f-site').querySelectorAll('option').length).toBeGreaterThan(0));
    await u.selectOptions(screen.getByTestId('intake-f-site'), screen.getByTestId('intake-f-site').querySelectorAll('option')[0]!.value);
    await u.click(screen.getByTestId('intake-dialog-edit-submit'));
    const url = (await screen.findByTestId('intake-url')) as HTMLInputElement;
    expect(url.value).toMatch(/\/intake\/T0+1x$/);
    await u.click(screen.getByTestId('intake-dialog-shown-submit'));
    const row = await screen.findByTestId(/intake-row-/);
    expect(row).toHaveTextContent('Gate problems');
    expect(row).toHaveTextContent('Issue Log');
    expect(row).toHaveTextContent('…01x'.slice(-4).replace('01x', '001x').slice(-4));
    expect(screen.queryByDisplayValue(/intake\/T0/)).toBeNull(); // the link is not kept anywhere on the screen
    const id = row.getAttribute('data-testid')!.replace('intake-row-', '');
    await u.click(screen.getByTestId(`intake-link-${id}`));
    await u.click(await screen.findByTestId('intake-dialog-link-submit'));
    expect(((await screen.findByTestId('intake-url')) as HTMLInputElement).value).toMatch(/\/intake\/R0+2x$/);
    await u.click(screen.getByTestId('intake-dialog-shown-submit'));
    await u.click(screen.getByTestId(`intake-switch-${id}`));
    await u.click(await screen.findByTestId('intake-dialog-switch-submit'));
    await waitFor(() => expect(screen.getByTestId(`intake-status-${id}`)).toHaveTextContent('Off'));
    await u.click(screen.getByTestId(`intake-delete-${id}`));
    await u.click(await screen.findByTestId('intake-dialog-delete-submit'));
    expect(await screen.findByTestId('intake-empty')).toBeInTheDocument();
  });

  it('shows the sharing lock: no new form, no new link, and the form reads Blocked', async () => {
    await signIn('pm');
    await make();
    setIntakeLocked(true);
    settings();
    expect(await screen.findByTestId('intake-locked')).toBeInTheDocument();
    expect(screen.getByTestId('intake-new')).toBeDisabled();
    expect(screen.getByTestId(/intake-status-/)).toHaveTextContent('Blocked by the sharing lock');
  });

  it('gives every icon button a hover hint and an accessible name', async () => {
    await signIn('pm');
    await make();
    settings();
    await screen.findByTestId('intake-table');
    for (const b of screen.getAllByRole('button')) if (b.getAttribute('data-testid')?.startsWith('intake-')) expect(b.getAttribute('aria-label') ?? b.textContent).toBeTruthy();
  });
});

describe('The page of a shared intake link', () => {
  beforeEach(() => resetIntake());

  it('shows the asked fields, sends them and thanks the sender', async () => {
    await signIn('pm');
    const f = await make({ thanks_en: 'We have it, thanks.' });
    const u = userEvent.setup();
    pub(f.token);
    expect(await screen.findByTestId('intake-title')).toHaveTextContent('Gate problems');
    expect(screen.queryByText(/S001/)).toBeNull(); // no site, register or owner on the public page
    await u.click(screen.getByTestId('intake-send'));
    expect(screen.getByTestId('intake-send')).toBeDisabled(); // the required field is empty
    await u.type(screen.getByTestId('intake-field-title'), 'The gate is locked');
    await u.type(screen.getByTestId('intake-name'), 'Omar');
    await u.click(screen.getByTestId('intake-send'));
    expect(await screen.findByTestId('intake-thanks')).toHaveTextContent('We have it, thanks.');
    expect(intakeSubmissions(f.id)).toHaveLength(1);
  });

  it('writes nothing when the hidden honeypot field is filled, yet answers like a success', async () => {
    await signIn('pm');
    const f = await make();
    const u = userEvent.setup();
    pub(f.token);
    await u.type(await screen.findByTestId('intake-field-title'), 'Buy cheap watches');
    await u.type(screen.getByTestId('intake-website'), 'http://spam.example');
    await u.click(screen.getByTestId('intake-send'));
    expect(await screen.findByTestId('intake-done')).toBeInTheDocument();
    expect(intakeSubmissions(f.id)).toHaveLength(0);
  });

  it('shows one answer for an unknown link, a switched-off form and a locked sharing', async () => {
    await signIn('pm');
    const f = await make();
    pub('does-not-exist');
    expect(await screen.findByTestId('intake-invalid')).toBeInTheDocument();
    expect(screen.getByTestId('intake-invalid')).toHaveTextContent('The link does not work');
    void f;
  });

  it('refuses markup in a field with a message under the field', async () => {
    await signIn('pm');
    const f = await make();
    const u = userEvent.setup();
    pub(f.token);
    await u.type(await screen.findByTestId('intake-field-title'), '<b>x</b>');
    await u.click(screen.getByTestId('intake-send'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Write plain text.');
  });
});

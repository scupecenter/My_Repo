import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '@/App';
import { DEMO_PASSWORDS, loginPage } from '@/mocks/db';
import { renderApp } from '@/test/utils';

/** The sign-in page (owner request 2026-11-26, contract 0.15.97): the calm backdrop, the announcement, the footer and the post-sign-in splash. */

describe('Login page', () => {
  it('shows the calm backdrop and the footer with the availability dot; by default there is no announcement', async () => {
    renderApp(<App />, { route: '/login' });
    expect(await screen.findByTestId('login-identifier')).toBeInTheDocument();
    expect(screen.getByTestId('login-form')).toBeInTheDocument();
    expect(screen.getByTestId('auth-shell')).toBeInTheDocument();
    expect(screen.queryByTestId('auth-announcement')).not.toBeInTheDocument();
    expect(await screen.findByTestId('auth-status')).toHaveTextContent(/available|متاحة/);
    expect(screen.getByTestId('auth-footer')).toBeInTheDocument();
    expect(screen.getByTestId('auth-lang')).toBeInTheDocument();
    expect(screen.getByTestId('login-password-toggle')).toBeInTheDocument();
  });

  it('shows the configured announcement and the support links', async () => {
    Object.assign(loginPage(), {
      announcement_en: 'Maintenance on Sunday.', announcement_ar: '', announcement_kind: 'maintenance',
      support_links: [{ label_en: 'IT support', label_ar: '', url: 'mailto:it@example.test' }],
    });
    renderApp(<App />, { route: '/login' });
    const note = await screen.findByTestId('auth-announcement');
    expect(note).toHaveTextContent('Maintenance on Sunday.');
    expect(note).toHaveAttribute('data-kind', 'maintenance');
    const link = screen.getByTestId('auth-support-0');
    expect(link).toHaveTextContent('IT support');
    expect(link).toHaveAttribute('href', 'mailto:it@example.test');
  });

  it('shows the post-sign-in splash with the version, then moves on to the app', async () => {
    renderApp(<App />, { route: '/login' });
    const u = userEvent.setup();
    await u.type(await screen.findByTestId('login-identifier'), '1001');
    await u.type(screen.getByTestId('login-password'), DEMO_PASSWORDS.pm);
    await u.click(screen.getByTestId('login-submit'));
    expect(await screen.findByTestId('post-login')).toBeInTheDocument();
    expect(screen.getByTestId('post-login-version')).toHaveTextContent('0.15.97');
    await waitFor(() => expect(screen.queryByTestId('post-login')).not.toBeInTheDocument(), { timeout: 4000 });
  }, 10_000);
});

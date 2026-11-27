import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { renderApp, signIn } from '@/test/utils';
import { SettingsRoutes } from './settings/Settings';

/** Contract 0.15.322 (D49 part 3, migration 0492): Settings, Imports shows the upload policy; only the two modes the server enforces are offered. */
const Routed = () => (
  <Routes>
    <Route path="/admin/settings/*" element={<SettingsRoutes />} />
  </Routes>
);

describe('Settings, Imports: the upload policy', () => {
  const open = (locale?: 'ar') => renderApp(<Routed />, { route: '/admin/settings/data/imports', ...(locale ? { locale } : {}) });

  it('a System Admin sees Enforce in force, offers two modes only, and saves Accept incomplete with a reason', async () => {
    await signIn('pm');
    open();
    const u = userEvent.setup();
    expect(await screen.findByTestId('page-upload-policy')).toHaveTextContent('Upload policy');
    expect(screen.getByTestId('upload-policy-enforce')).toBeChecked();
    expect(screen.getByTestId('upload-policy-accept_incomplete')).not.toBeChecked();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.getByTestId('upload-policy-current')).toHaveTextContent('Enforce the sequence');
    expect(screen.getByTestId('upload-policy-save')).toBeDisabled();
    await u.click(screen.getByTestId('upload-policy-accept_incomplete'));
    await u.click(screen.getByTestId('upload-policy-save'));
    expect(screen.getByTestId('upload-policy-confirm')).toHaveTextContent('from Enforce the sequence (default) to Accept incomplete data');
    await u.click(screen.getByTestId('upload-policy-dialog-submit'));
    expect(screen.getByTestId('upload-policy-dialog-reason-error')).toBeInTheDocument();
    await u.type(screen.getByTestId('upload-policy-dialog-reason'), 'Historical sheets arrive incomplete');
    await u.click(screen.getByTestId('upload-policy-dialog-submit'));
    await waitFor(() => expect(screen.getByTestId('upload-policy-current')).toHaveTextContent('Accept incomplete data'));
    expect(screen.getByTestId('upload-policy-accept_incomplete')).toBeChecked();
  }, 30_000);

  it('another user sees the policy read-only; in Arabic the labels are translated', async () => {
    await signIn('reviewer');
    open('ar');
    expect(await screen.findByTestId('page-upload-policy')).toHaveTextContent('سياسة الرفع');
    expect(screen.getByTestId('upload-policy-enforce')).toBeDisabled();
    expect(screen.queryByTestId('upload-policy-save')).not.toBeInTheDocument();
    expect(screen.getByTestId('upload-policy-readonly')).toBeInTheDocument();
    expect(screen.getByTestId('upload-policy-current')).toHaveTextContent('فرض التسلسل');
  }, 30_000);
});

import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { api } from '@/api/client';
import { renderApp, signIn } from '@/test/utils';
import { ActivityReport } from './ActivityReport';

/** The UI guard for browser-built files (S1b): with disable_export on, the report buttons are disabled and say why. Off by default, so they work as before. */
describe('Export UI gate', () => {
  it('leaves the report buttons enabled by default, disables them when export is locked', async () => {
    await signIn('pm');
    renderApp(<ActivityReport />);
    const csv = await screen.findByTestId('report-xlsx');
    expect(csv).toBeEnabled();
    const cur = await api.get<{ version: number }>('/settings/security-locks');
    await api.post('/__mock/step-up');
    await api.put('/settings/security-locks', { version: cur.version, body: { block_public_sharing: false, disable_export: true, reason: 'test' } });
    renderApp(<ActivityReport />);
    await waitFor(() => expect(screen.getAllByTestId('report-xlsx').some((b) => (b as HTMLButtonElement).disabled)).toBe(true));
  });
});

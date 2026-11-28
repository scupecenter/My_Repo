import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { api, ApiError } from '@/api/client';
import { renderApp, signIn } from '@/test/utils';
import { OldVersions } from './OldVersions';

/** Contract 0.15.436: an old published version is deleted from the Studio after the reason, the step-up and the typed confirmation. */
const REASON = 'Old version no longer needed';
const errCode = async (p: Promise<unknown>) => p.then(() => null, (e: ApiError) => `${e.status}:${e.code}`);
const etagOf = async (v: number) => (await api.get<{ version_etag: number }>(`/workflow/versions/${v}`)).version_etag;
async function publishNext(parent: number, v: number) {
  await api.post('/workflow/versions', { body: { parent_version: parent, reason: REASON } });
  await api.post(`/workflow/versions/${v}/publish`, { body: { reason: REASON, confirm_text: `v${v}` }, version: await etagOf(v) });
}

describe('delete an old published version', () => {
  it('refuses the current version, a version with sites and a wrong confirmation; deletes an unused old one', async () => {
    await signIn('pm');
    await api.post('/__mock/step-up');
    await publishNext(1, 2);
    await publishNext(2, 3);
    expect(await errCode(api.post('/workflow/versions/3/delete', { body: { reason: REASON, confirm_text: 'v3' }, version: await etagOf(3) }))).toBe('409:invalid_transition');
    expect(await errCode(api.post('/workflow/versions/1/delete', { body: { reason: REASON, confirm_text: 'v1' }, version: await etagOf(1) }))).toBe('409:invalid_transition');
    expect(await errCode(api.post('/workflow/versions/2/delete', { body: { reason: REASON, confirm_text: 'v9' }, version: await etagOf(2) }))).toBe('422:confirmation_mismatch');

    const u = userEvent.setup();
    renderApp(<Routes><Route path="/" element={<OldVersions />} /></Routes>);
    expect(await screen.findByTestId('old-version-1')).toBeInTheDocument();
    expect(screen.getByTestId('old-version-delete-1')).toBeDisabled();
    await u.click(await screen.findByTestId('old-version-delete-2'));
    const dlg = await screen.findByTestId('old-version-delete-dialog');
    expect(dlg).toBeInTheDocument();
    await u.type(screen.getByTestId('old-version-confirm'), 'v2');
    await u.type(screen.getByRole('textbox', { name: /reason/i }), REASON);
    await u.click(screen.getByTestId('old-version-delete-dialog-submit'));
    await waitFor(() => expect(screen.queryByTestId('old-version-2')).not.toBeInTheDocument());
    expect((await api.get<{ items: { version: number }[] }>('/workflow/versions')).items.map((x) => x.version)).not.toContain(2);
  });
});

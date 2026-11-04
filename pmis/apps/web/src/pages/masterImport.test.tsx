import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { api, API_BASE } from '@/api/client';
import { TemplateUploadDialog } from '@/components/TemplateUploadDialog';
import { server } from '@/mocks/server';
import { renderApp, signIn } from '@/test/utils';
import { ReconciliationPage } from './Reconciliation';
import { TemplateMappingPage } from './TemplateMapping';

/** Contract 0.12.8 (P3): the legacy Master import and the comparison report (Q1, Q211), the template mapping screen and the aliases (Q207, Q8, Q10), the upload mode (Q206). */
const Routed = () => (
  <Routes>
    <Route path="/templates/master-import" element={<ReconciliationPage />} />
    <Route path="/templates/mapping" element={<TemplateMappingPage />} />
  </Routes>
);

describe('Master import and comparison (Q1, Q211)', () => {
  it('uploads the Master, opens the run with its structure check and differences, records a resolution with a note, and exports the report', async () => {
    await signIn('pm');
    renderApp(<Routed />, { route: '/templates/master-import' });
    const u = userEvent.setup();
    expect(await screen.findByTestId('mi-run-run-0001')).toBeInTheDocument();
    await u.upload(screen.getByTestId('mi-file'), new File(['Master sheet'], 'GSDN_Site_Master.xlsx'));
    await u.click(screen.getByTestId('mi-upload'));
    const detail = await screen.findByTestId('mi-run-detail');
    expect(within(detail).getByTestId('mi-identified')).toHaveTextContent('187 of 187');
    const diff = await screen.findByTestId('mi-diff-diff-1-run-2');
    expect(diff).toHaveAttribute('data-reason', 'value_differs');
    expect(diff).toHaveTextContent('Master!5');
    expect(diff).toHaveTextContent('2026-02-03');
    expect(screen.getByTestId('mi-diff-diff-4-run-2')).toHaveTextContent('Ambiguous role');

    await u.click(screen.getByTestId('mi-resolve-diff-1-run-2'));
    const save = screen.getByTestId('mi-resolve-save');
    expect(save).toBeDisabled();                                    // a note is required
    await u.type(screen.getByTestId('mi-resolve-note'), 'The task date is right.');
    await u.click(save);
    await waitFor(() => expect(screen.getByTestId('mi-diff-diff-1-run-2')).toHaveTextContent('The task date is right.'));

    let exported = '';
    server.use(http.get(`${API_BASE}/master-import/runs/:id/export`, ({ request }) => {
      exported = new URL(request.url).search;
      return new HttpResponse(new Uint8Array([1]), { headers: { 'Content-Disposition': 'attachment; filename="r.xlsx"' } });
    }));
    await u.selectOptions(screen.getByTestId('mi-filter-kind'), 'exception');
    await waitFor(() => expect(screen.queryByTestId('mi-diff-diff-1-run-2')).not.toBeInTheDocument());
    await u.click(screen.getByTestId('mi-export'));
    await waitFor(() => expect(exported).toContain('kind=exception'));
  });

  it('shows the refusal of a file that is not the Master with the server reason, and refuses the page to a non-admin', async () => {
    await signIn('pm');
    const { unmount } = renderApp(<Routed />, { route: '/templates/master-import' });
    const u = userEvent.setup();
    await u.upload(await screen.findByTestId('mi-file'), new File(['_tpl Master'], 'filled.xlsx'));
    await u.click(screen.getByTestId('mi-upload'));
    const err = await screen.findByTestId('mi-upload-error');
    expect(err).toHaveAttribute('data-reason', 'is_pmis_template');
    expect(err).toHaveTextContent('Templates page');
    unmount();
    await signIn('engineer');
    renderApp(<Routed />, { route: '/templates/master-import' });
    expect(await screen.findByTestId('mi-forbidden')).toBeInTheDocument();
  });

  it('applies a run with a mode and a reason', async () => {
    await signIn('pm');
    await api.post('/__mock/step-up');                              // a fresh re-authentication, as the apply needs
    renderApp(<Routed />, { route: '/templates/master-import?run=run-0001' });
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('mi-apply'));
    const confirm = screen.getByTestId('mi-apply-confirm');
    expect(confirm).toBeDisabled();
    await u.click(screen.getByTestId('mi-mode-draft'));
    await u.type(screen.getByTestId('mi-apply-reason'), 'Initial load');
    await u.click(confirm);
    await waitFor(() => expect(screen.getByTestId('mi-applied')).toHaveTextContent('Save Draft / Planning'), { timeout: 10000 });
  });
});

describe('Template mapping and aliases (Q207, Q8, Q10)', () => {
  it('tests a change and shows its impact, shows a refusal of a calculated field as typed, and saves a role alias with a reason', async () => {
    await signIn('pm');
    renderApp(<Routed />, { route: '/templates/mapping' });
    const u = userEvent.setup();
    expect(await screen.findByTestId('tmap-field-B10-actual_start')).toHaveTextContent('Earliest');
    await u.click(screen.getByTestId('tmap-add'));
    await u.type(screen.getByTestId('tmap-task'), 'B6');
    await u.type(screen.getByTestId('tmap-key'), 'v:layout_ref');
    await u.type(screen.getByTestId('tmap-label'), 'Layout Ref');
    await u.type(screen.getByTestId('tmap-reason'), 'add the reference');
    await u.click(screen.getByTestId('tmap-test'));
    expect(await screen.findByTestId('tmap-impact-TPL-SITE-CW')).toHaveTextContent('B6 Layout Ref');
    await u.click(screen.getByRole('button', { name: 'Cancel' }));

    await u.click(screen.getByTestId('tmap-edit-B7-submitted_date'));
    await u.click(screen.getByTestId('tmap-readonly'));            // try to make a field the workflow sets typed
    await u.type(screen.getByTestId('tmap-reason'), 'try it');
    await u.click(screen.getByTestId('tmap-test'));
    expect(await screen.findByTestId('tmap-errors')).toHaveTextContent('read only');
    await u.click(screen.getByRole('button', { name: 'Cancel' }));

    await u.click(screen.getByTestId('tmap-tab-role'));
    expect(await screen.findByTestId('tmap-alias-site engineer')).toHaveAttribute('data-status', 'ambiguous');
    await u.click(screen.getByTestId('tmap-alias-edit-team lead (cw)'));
    await u.type(screen.getByTestId('alias-target'), 'CW_TEAM_LEAD');
    await u.type(screen.getByTestId('alias-reason'), 'owner mapping');
    await u.click(screen.getByTestId('alias-save'));
    await waitFor(() => expect(screen.getByTestId('tmap-alias-team lead (cw)')).toHaveAttribute('data-status', 'mapped'));
  });

  it('renders in Arabic', async () => {
    await signIn('pm');
    renderApp(<Routed />, { route: '/templates/mapping?tab=region', locale: 'ar' });
    expect(await screen.findByTestId('tmap-alias-tripoli area')).toHaveTextContent('مربوط');
    expect(screen.getByText('ربط القوالب')).toBeInTheDocument();
  });
});

describe('upload mode (Q206)', () => {
  it('sends Save Draft / Planning for a stream template, and never offers it for a register template', async () => {
    await signIn('pm');
    let mode: string | null = 'unset';
    server.use(http.post(`${API_BASE}/import-batches`, async ({ request }) => {
      mode = (await request.formData()).get('mode') as string | null;
      return HttpResponse.json({ id: 'b-1', template_id: 'TPL-SITE-CW', template_version: 2, status: 'validated', counts: {}, version: 1, mode: 'draft' }, { status: 202 });
    }));
    const { unmount } = renderApp(<TemplateUploadDialog open onClose={() => undefined} templateId="TPL-SITE-CW" templateName="CW" kind="stream" onDone={() => undefined} />);
    const u = userEvent.setup();
    expect(screen.getByTestId('template-upload-mode')).toHaveTextContent('Save Draft / Planning');
    await u.click(screen.getByTestId('template-upload-mode-draft'));
    await u.upload(screen.getByTestId('template-upload-file'), new File(['x'], 'cw.xlsx'));
    await u.click(screen.getByTestId('template-upload-submit'));
    await waitFor(() => expect(mode).toBe('draft'));
    unmount();
    renderApp(<TemplateUploadDialog open onClose={() => undefined} templateId="TPL-GECOL" templateName="GECOL" kind="register" onDone={() => undefined} />);
    expect(screen.queryByTestId('template-upload-mode')).not.toBeInTheDocument();
  });
});

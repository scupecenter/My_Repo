import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { api } from '@/api/client';
import type { ImportBatch, Page, SiteDraft } from '@/api/types';
import { siteMeta } from '@/mocks/sites';
import { renderApp, signIn } from '@/test/utils';
import { NewSite } from './NewSite';
import { RegisterBatch } from './RegisterBatch';
import { Sites } from './Sites';

/** Site creation (contract 0.14.0, Q460): the New site form, the template buttons of the Site Register, and the L2 review of a New sites batch. */
const Routed = () => (
  <Routes>
    <Route path="/sites" element={<Sites />} />
    <Route path="/sites/new" element={<NewSite />} />
    <Route path="/templates/batches/:batchId" element={<RegisterBatch />} />
  </Routes>
);

const fill = async (u: ReturnType<typeof userEvent.setup>, o: Record<string, string>) => {
  for (const [k, v] of Object.entries(o)) {
    const el = await screen.findByTestId(`ns-${k}`);
    if (el.tagName === 'SELECT') await u.selectOptions(el, v);
    else { await u.clear(el); await u.type(el, v); }
  }
};

describe('Site Register: New site, Download template, Upload', () => {
  it('offers all three to somebody who may create sites and use the Templates page', async () => {
    await signIn('pm');
    renderApp(<Routed />, { route: '/sites' });
    expect(await screen.findByTestId('sites-new')).toHaveAttribute('href', '/sites/new');
    expect(await screen.findByTestId('sites-template-download')).toBeInTheDocument();
    expect(screen.getByTestId('sites-template-upload')).toBeInTheDocument();
  });

  it('offers only New site to somebody who creates by hand and has no Templates page (the template is listed only for those who can use it)', async () => {
    await signIn('engineer');
    renderApp(<Routed />, { route: '/sites' });
    expect(await screen.findByTestId('sites-new')).toBeInTheDocument();
    await screen.findByTestId(`site-row-${siteMeta(0).code}`);
    expect(screen.queryByTestId('sites-template-download')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sites-template-upload')).not.toBeInTheDocument();
  });

  it('offers nothing to somebody who may not create sites', async () => {
    await signIn('auditor');
    renderApp(<Routed />, { route: '/sites' });
    await screen.findByTestId('page-sites');
    expect(screen.queryByTestId('sites-create-actions')).not.toBeInTheDocument();
  });

  it('shows the Arabic site name next to the English one (G9)', async () => {
    await signIn('pm');
    renderApp(<Routed />, { route: '/sites' });
    const row = await screen.findByTestId(`site-row-${siteMeta(0).code}`);
    expect(within(row).getByTestId(`site-name-ar-${siteMeta(0).code}`)).toHaveTextContent(`موقع ${siteMeta(0).name}`);
    expect(within(row).getByTestId(`site-name-ar-${siteMeta(0).code}`)).toHaveAttribute('dir', 'rtl');
    expect(screen.queryByTestId(`site-name-ar-${siteMeta(1).code}`)).not.toBeInTheDocument();
  });

  it('downloads the New sites template from the Site Register', async () => {
    await signIn('pm');
    renderApp(<Routed />, { route: '/sites' });
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('sites-template-download'));
    await waitFor(() => expect(screen.getAllByTestId('toast').at(-1)).toHaveTextContent('TPL-SITE-NEW'));
  });
});

describe('New site: the manual way', () => {
  it('L1 enters a draft in English and Arabic, sends it; L2 approves it with step-up and the site opens', async () => {
    await signIn('engineer');
    const first = renderApp(<Routed />, { route: '/sites/new' });
    const u = userEvent.setup();
    expect(await screen.findByTestId('new-site-form')).toBeInTheDocument();
    expect(screen.getByTestId('ns-privacy-note')).toHaveTextContent(/not loaded/);
    await fill(u, { site_code: 'NS-HAND-1', region_id: '1', name: 'Hand site', name_ar: 'موقع يدوي', delivery_scenario: 'expansion', scope_tower_erection: 'Yes' });
    expect(screen.getByTestId('ns-name_ar')).toHaveAttribute('dir', 'rtl');
    await u.click(screen.getByTestId('ns-save'));
    const row = await screen.findByTestId('ns-draft-NS-HAND-1');
    expect(row).toHaveAttribute('data-status', 'entry');
    expect(within(row).getByTestId('ns-draft-name-ar-NS-HAND-1')).toHaveTextContent('موقع يدوي');
    await u.click(within(row).getByTestId('ns-submit-NS-HAND-1'));
    await waitFor(() => expect(screen.getByTestId('ns-draft-NS-HAND-1')).toHaveAttribute('data-status', 'in_approval'));
    // the engineer holds L1 only: no approve button
    expect(screen.queryByTestId('ns-approve-NS-HAND-1')).not.toBeInTheDocument();

    await signIn('reviewer');
    first.unmount();
    renderApp(<Routed />, { route: '/sites/new' });
    const waiting = await screen.findByTestId('ns-draft-NS-HAND-1');
    await api.post('/__mock/step-up');
    await u.click(within(waiting).getByTestId('ns-approve-NS-HAND-1'));
    await waitFor(() => expect(screen.getByTestId('ns-draft-NS-HAND-1')).toHaveAttribute('data-status', 'approved'));
    expect(screen.getByTestId('ns-open-NS-HAND-1')).toBeInTheDocument();
    const list = await api.get<Page<SiteDraft>>('/site-drafts');
    expect(list.items.find((d) => d.site_code === 'NS-HAND-1')).toMatchObject({ status: 'approved', self_approval: false });
  });

  it('L2 returns a draft with a note (mandatory), and L1 sees it', async () => {
    await signIn('engineer');
    const first = renderApp(<Routed />, { route: '/sites/new' });
    const u = userEvent.setup();
    await fill(u, { site_code: 'NS-BACK-1', region_id: '2', name: 'Back site' });
    await u.click(screen.getByTestId('ns-save'));
    await u.click(await screen.findByTestId('ns-submit-NS-BACK-1'));
    await waitFor(() => expect(screen.getByTestId('ns-draft-NS-BACK-1')).toHaveAttribute('data-status', 'in_approval'));
    await signIn('reviewer');
    first.unmount();
    const second = renderApp(<Routed />, { route: '/sites/new' });
    await u.click(await screen.findByTestId('ns-return-NS-BACK-1'));
    await u.click(await screen.findByTestId('reject-submit'));
    expect(await screen.findByTestId('reject-error')).toBeInTheDocument();
    await u.type(screen.getByTestId('reject-note'), 'Wrong region');
    await u.click(screen.getByTestId('reject-submit'));
    await waitFor(() => expect(screen.getByTestId('ns-draft-NS-BACK-1')).toHaveAttribute('data-status', 'entry'));
    await signIn('engineer');
    second.unmount();
    renderApp(<Routed />, { route: '/sites/new' });
    expect(await screen.findByTestId('ns-draft-note-NS-BACK-1')).toHaveTextContent('Wrong region');
  });

  it('shows the field errors of the server: a Site ID that exists, a missing name, a latitude without a longitude', async () => {
    await signIn('engineer');
    renderApp(<Routed />, { route: '/sites/new' });
    const u = userEvent.setup();
    await fill(u, { site_code: siteMeta(10).code, region_id: '1', latitude: '32.5' });
    await u.click(screen.getByTestId('ns-save'));
    expect(await screen.findByTestId('ns-error-site_code')).toHaveTextContent(/never reused/);
    expect(screen.getByTestId('ns-error-name')).toBeInTheDocument();
    expect(screen.getByTestId('ns-error-longitude')).toBeInTheDocument();
    expect(screen.queryByTestId(`ns-draft-${siteMeta(10).code}`)).not.toBeInTheDocument();
  });

  it('is in Arabic (RTL) with the Arabic labels', async () => {
    await signIn('engineer');
    renderApp(<Routed />, { route: '/sites/new', locale: 'ar' });
    expect(await screen.findByRole('heading', { name: 'موقع جديد', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('اسم الموقع (بالعربية)')).toBeInTheDocument();
    expect(screen.getByTestId('ns-privacy-note')).toHaveTextContent('لا تُحمَّل');
    expect(document.documentElement.dir).toBe('rtl');
  });
});

describe('New sites: the template and the L2 review of the batch', () => {
  const uploadFor = async (account: 'reviewer' | 'pm', content = 'x') => {
    await signIn(account);
    const view = renderApp(<Routed />, { route: '/sites' });
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('sites-template-upload'));
    await u.upload(await screen.findByTestId('template-upload-file'), new File([content], 'new-sites.xlsx'));
    await u.click(screen.getByTestId('template-upload-submit'));
    return { u, view };
  };

  it('uploads the file, shows the row preview, is sent by L1 and approved by L2 row by row and all at once, each approval giving its site', async () => {
    const { u, view } = await uploadFor('reviewer');
    await screen.findByTestId('page-register-batch');
    expect(await screen.findByTestId('batch-count-valid')).toHaveTextContent('2');
    expect(screen.getByTestId('batch-count-invalid')).toHaveTextContent('2');
    // the preview: the diff of a new row (with the Arabic name), the reasons of the invalid ones, the cluster warning
    expect(screen.getByTestId('batch-diff-2-name_ar')).toHaveTextContent('الموقع الجديد الأول');
    expect(screen.getByTestId('batch-cell-error-4-site_code')).toHaveTextContent(/never reused/);
    expect(screen.getByTestId('batch-cell-error-5-region')).toHaveTextContent(/Unknown region/);
    expect(screen.getByTestId('batch-warning-3-cluster_will_be_created')).toBeInTheDocument();
    await u.click(screen.getByTestId('batch-submit'));
    await waitFor(() => expect(screen.getByTestId('batch-status')).toHaveTextContent('In approval'));
    const id = (await api.get<Page<ImportBatch>>('/import-batches', { query: { status: 'in_approval' } })).items[0]!.id;
    expect((await api.get<Page<ImportBatch>>('/import-batches')).items.find((b) => b.id === id)).toMatchObject({ entity: 'site', template_id: 'TPL-SITE-NEW' });

    await signIn('pm');
    view.unmount();
    renderApp(<Routed />, { route: `/templates/batches/${id}` });
    await api.post('/__mock/step-up');
    await u.click(await screen.findByTestId('batch-row-approve-2'));
    await waitFor(() => expect(screen.getByTestId('batch-decision-2')).toHaveTextContent('Approved'));
    expect(screen.getByTestId('batch-open-site-2')).toBeInTheDocument();
    await u.click(screen.getByTestId('batch-approve-all'));
    await waitFor(() => expect(screen.getByTestId('batch-status')).toHaveTextContent('Approved'));
    expect(screen.getByTestId('batch-open-site-3')).toBeInTheDocument();
  });

  it('L2 returns a row of the batch with a note', async () => {
    const { u, view } = await uploadFor('reviewer');
    await u.click(await screen.findByTestId('batch-submit'));
    await waitFor(() => expect(screen.getByTestId('batch-status')).toHaveTextContent('In approval'));
    const id = (await api.get<Page<ImportBatch>>('/import-batches', { query: { status: 'in_approval' } })).items[0]!.id;
    await signIn('pm');
    view.unmount();
    renderApp(<Routed />, { route: `/templates/batches/${id}` });
    await u.click(await screen.findByTestId('batch-row-reject-3'));
    await u.type(await screen.findByTestId('reject-note'), 'Not in scope');
    await u.click(screen.getByTestId('reject-submit'));
    await waitFor(() => expect(screen.getByTestId('batch-decision-3')).toHaveTextContent('Returned'));
    expect(screen.getByTestId('batch-note-3')).toHaveTextContent('Not in scope');
  });

  it('refuses a file of an old version, and a changed header, in the dialog with the server reason', async () => {
    await signIn('reviewer');
    renderApp(<Routed />, { route: '/sites' });
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('sites-template-upload'));
    expect(await screen.findByTestId('template-upload-rule-sites')).toBeInTheDocument();
    expect(screen.queryByTestId('template-upload-mode')).not.toBeInTheDocument();    // a New sites file is always submitted
    await u.upload(await screen.findByTestId('template-upload-file'), new File(['retired'], 'old.xlsx'));
    await u.click(screen.getByTestId('template-upload-submit'));
    expect(await screen.findByTestId('template-upload-error')).toHaveAttribute('data-reason', 'outdated_version');
    await u.upload(screen.getByTestId('template-upload-file'), new File(['tampered'], 'changed.xlsx'));
    await u.click(screen.getByTestId('template-upload-submit'));
    await waitFor(() => expect(screen.getByTestId('template-upload-error')).toHaveAttribute('data-reason', 'checksum_mismatch'));
  });

  it('shows the New sites template on the Templates page with its kind', async () => {
    await signIn('pm');
    const { TemplatesPage } = await import('./Templates');
    renderApp(<TemplatesPage />, { route: '/templates' });
    expect(await screen.findByTestId('tpl-row-TPL-SITE-NEW')).toBeInTheDocument();
    expect(screen.getByTestId('tpl-kind-TPL-SITE-NEW')).toHaveTextContent('New sites');
  });
});

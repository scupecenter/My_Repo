import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '@/App';
import { resetLibraryMock } from '@/mocks/handlers.library';
import { siteMeta } from '@/mocks/sites';
import { renderApp, signIn } from '@/test/utils';

/**
 * W5 of plan 2026-11-23-next-ui-cleanup (contract 0.15.70): the Library menu (Forms and Archive), the Archive list with the table standard, the lifecycle
 * on the site's Documents tab, Settings > Documents (Document types, Form templates, Archive) and Data entry > Templates without document forms.
 */
const S0 = siteMeta(0), S1 = siteMeta(1);
beforeEach(() => resetLibraryMock());

describe('Library > Forms', () => {
  it('the side menu has Library (Forms, Archive) between Data entry and Administration', async () => {
    await signIn('pm');
    renderApp(<App />, { route: '/library/forms' });
    expect(await screen.findByTestId('page-library-forms')).toBeInTheDocument();
    expect(await screen.findByTestId('nav-library.forms')).toHaveAttribute('href', '/library/forms');
    expect(screen.getByTestId('nav-library.archive')).toHaveAttribute('href', '/library/archive');
    const groups = [...document.querySelectorAll('[data-testid^="nav-group-"][data-depth="1"]')].map((g) => g.getAttribute('data-testid'));
    const at = (id: string) => groups.indexOf(`nav-group-${id}`);
    expect(at('library')).toBeGreaterThan(at('data'));
    expect(at('library')).toBeLessThan(at('admin'));
  });

  it('lists the approved forms with code, version, document type, triggering task and numbering; an admin gets the Settings links', async () => {
    await signIn('pm');
    renderApp(<App />, { route: '/library/forms' });
    const row = await screen.findByTestId('lib-form-SSR');
    expect(row).toHaveTextContent('Site survey report');
    expect(row).toHaveTextContent('v1');
    expect(row).toHaveTextContent('A2');
    expect(row).toHaveTextContent('SSR-{YYYY}-{SEQ:4}');
    expect(screen.getByTestId('lib-settings-links')).toBeInTheDocument();
    expect(screen.getByTestId('lib-forms-count')).toHaveTextContent('1');
  });

  it('generates a filled document: auto-filled preview in a sandboxed frame, the number, then the signed copy is uploaded', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<App />, { route: '/library/forms' });
    await u.click(await screen.findByTestId('lib-form-generate-SSR'));
    const dlg = await screen.findByTestId('lib-generate-dialog');
    await u.type(within(dlg).getByTestId('lib-site-input'), S1.code);
    await u.click(await screen.findByTestId(`lib-site-hit-${S1.code}`));
    const frame = await screen.findByTestId('lib-preview-frame');
    // no script, no same origin: the filled form is a document only
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('srcdoc')).toContain(S1.code);
    expect(frame.getAttribute('srcdoc')).toContain('PREVIEW');
    await u.click(screen.getByTestId('lib-generate'));
    expect(await screen.findByTestId('lib-generated-number')).toHaveTextContent('SSR-2026-0001');
    expect(await screen.findByTestId('lib-generated-status')).toHaveTextContent('Generated');
    await u.upload(screen.getByTestId('lib-upload-input'), new File(['%PDF-1.4 signed'], 'signed.pdf', { type: 'application/pdf' }));
    await waitFor(() => expect(screen.getByTestId('lib-generated-status')).toHaveTextContent('Signed and uploaded'));
  });

  it('Arabic and RTL', async () => {
    await signIn('pm');
    renderApp(<App />, { route: '/library/forms', locale: 'ar' });
    expect(await screen.findByTestId('lib-form-SSR')).toHaveTextContent('تقرير مسح الموقع');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('النماذج');
    expect(document.documentElement.dir).toBe('rtl');
  });
});

describe('Library > Archive', () => {
  it('one card per document type with a file or a generated copy, grouped by stream, with approved, waiting review and missing', async () => {
    await signIn('pm');
    renderApp(<App />, { route: '/library/archive' });
    const da = await screen.findByTestId('lib-group-DESIGN_ACQ');
    expect(within(da).getByTestId('lib-card-A1')).toBeInTheDocument();
    expect(within(da).getByTestId('lib-card-A2')).toBeInTheDocument();
    // B13 PAC has no file and no generated copy: no card
    expect(screen.queryByTestId('lib-card-B13_PAC')).toBeNull();
    expect(screen.getByTestId('lib-card-approved-A1')).toHaveTextContent('3');
    expect(screen.getByTestId('lib-card-waiting-A1')).toHaveTextContent('5');
    expect(screen.getByTestId('lib-card-missing-A2')).toHaveTextContent('7');
    expect(screen.getByTestId('lib-archive-settings')).toHaveAttribute('href', '/admin/settings/documents/archive');
  });

  it('the list of a type: the table standard (views, search, + Filter, count, columns, density, Display, Export, zip), # rows and the lifecycle', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    const { container } = renderApp(<App />, { route: '/library/archive/A2' });
    await waitFor(() => expect(container.querySelector('[data-table-standard][data-has-views][data-has-filter]')).not.toBeNull());
    const bar = screen.getByTestId('lib-archive-toolbar');
    for (const a of ['data-has-search', 'data-has-columns', 'data-has-density', 'data-has-display', 'data-has-export']) expect(bar.hasAttribute(a), a).toBe(true);
    expect(screen.getByTestId('lib-archive-zip')).toBeInTheDocument();
    expect(await screen.findByTestId('lib-archive-count')).toHaveTextContent('8 documents');
    expect(screen.getAllByTestId('row-no').map((x) => x.textContent)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
    const first = screen.getByTestId(`lib-row-site-${S0.code}`).closest('[role="row"]')!;
    expect(first.getAttribute('data-status')).toBe('approved');
    expect(within(first as HTMLElement).getByTestId('lib-status')).toHaveTextContent('Approved');
    // the site's Documents tab link and the Generate action of a due row
    expect(screen.getByTestId(`lib-row-site-${S0.code}`)).toHaveAttribute('href', `/sites/${S0.id}?tab=documents`);
    expect(screen.getByTestId(`lib-row-generate-S:7c1b0000-0000-4000-8000-${String(1 * 10 + 1 + 1).padStart(12, '0')}`)).toBeInTheDocument();
    // search: a pasted list of two Site IDs, one unknown
    await u.type(screen.getByTestId('lib-archive-search'), `${S1.code} NOPE9`);
    await waitFor(() => expect(screen.getByTestId('lib-archive-count')).toHaveTextContent('1 of 8 documents'));
    expect(screen.getByTestId('pasted-chip')).toHaveTextContent('2 pasted, 1 found');
  });

  it('the site Documents tab shows the lifecycle of its documents', async () => {
    await signIn('pm');
    renderApp(<App />, { route: `/sites/${S0.id}?tab=documents` });
    const box = await screen.findByTestId('site-doc-lifecycle');
    expect(within(box).getByTestId('site-doc-life-A1')).toHaveTextContent('Approved');
    expect(within(box).getByTestId('site-doc-lifecycle-approved')).toBeInTheDocument();
  });
});

describe('Settings > Documents and Data entry > Templates', () => {
  it('Documents has Document types, Form templates and Archive (Mail kinds moved to Alerts); the old Library route opens Document types', async () => {
    await signIn('pm');
    renderApp(<App />, { route: '/admin/settings/documents/library' });
    // react-router 7 applies a navigation in a transition, so the redirect lands a tick after the first render
    await waitFor(() => expect(screen.getByTestId('settings-section-documents-types')).toHaveClass('btn-accent'));
    for (const k of ['forms', 'archive']) expect(await screen.findByTestId(`settings-section-documents-${k}`)).toBeInTheDocument();
    expect(screen.queryByTestId('settings-section-documents-mail')).toBeNull();
    expect(screen.getByTestId('settings-section-documents-types')).toHaveTextContent('Document types');
  });

  it('Form templates: the versions with their state; a draft is approved with a reason', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<App />, { route: '/admin/settings/documents/forms' });
    expect(await screen.findByTestId('ft-row-SSR-v1')).toHaveAttribute('data-status', 'approved');
    await u.type(screen.getByTestId('ft-code'), 'HOC');
    await u.type(screen.getByTestId('ft-doc_code'), 'A1');
    await u.type(screen.getByTestId('ft-name_en'), 'Handover certificate');
    await u.type(screen.getByTestId('ft-trigger_task_code'), 'A1');
    await u.type(screen.getByTestId('ft-numbering_pattern'), 'HOC-{{YYYY}-{{SEQ:4}');
    await u.upload(screen.getByTestId('ft-file'), new File(['<p>{{site.id}}</p>'], 'hoc.html', { type: 'text/html' }));
    await u.click(screen.getByTestId('ft-upload'));
    const dlg = await screen.findByTestId('ft-upload-dialog');
    await u.type(within(dlg).getByRole('textbox'), 'Owner form');
    await u.click(within(dlg).getByRole('button', { name: /upload|save|confirm/i }));
    expect(await screen.findByTestId('ft-row-HOC-v1')).toHaveAttribute('data-status', 'draft');
  });

  it('Archive settings: hide a card and change the zip limit, with a reason', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<App />, { route: '/admin/settings/documents/archive' });
    await u.click(await screen.findByTestId('as-show-A1'));
    await u.clear(screen.getByTestId('as-zip'));
    await u.type(screen.getByTestId('as-zip'), '100');
    await u.click(screen.getByTestId('as-save'));
    const dlg = await screen.findByTestId('as-save-dialog');
    await u.type(within(dlg).getByRole('textbox'), 'Hide the SAR card');
    await u.click(within(dlg).getByRole('button', { name: /save|confirm/i }));
    await waitFor(() => expect(screen.queryByTestId('as-save-dialog')).toBeNull());
    expect(screen.getByTestId('as-show-A1')).not.toBeChecked();
  });

  it('Data entry > Templates is unchanged and lists no document form', async () => {
    await signIn('pm');
    renderApp(<App />, { route: '/templates' });
    expect(await screen.findByTestId('tpl-table')).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByRole('row').length).toBeGreaterThan(1));
    expect(screen.queryByText('Site survey report')).toBeNull();
    expect(screen.getByTestId('tpl-table')).not.toHaveTextContent(/SSR|form template/i);
  });
});

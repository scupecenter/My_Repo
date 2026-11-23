import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { api, API_BASE } from '@/api/client';
import en from '@/i18n/en.json';
import ar from '@/i18n/ar.json';
import { resetWorkflowEditorMock } from '@/mocks/handlers.workflowEditor';
import { problem } from '@/mocks/handlers';
import { server } from '@/mocks/server';
import { renderApp, signIn } from '@/test/utils';
import { SettingsRoutes } from './settings/Settings';

/** Workflow Studio S4: the pending changes panel with Undo, the impact numbers of the review, the closing task, the lock panel and the shortcuts the classic editor had, and the Arabic (RTL) pass. */
type U = ReturnType<typeof userEvent.setup>;
const REASON = 'The owner asked for it';
const page = (route = '/admin/settings/workflow/editor', locale: 'en' | 'ar' = 'en') => renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route, locale });
const reasonAndSave = async (u: U, dlg = 'studio-reason-dialog') => { await u.type(await screen.findByTestId(`${dlg}-reason`), REASON); await u.click(screen.getByTestId(`${dlg}-submit`)); };
const draftEtag = async () => (await api.get<{ version_etag: number }>('/workflow/versions/2')).version_etag;
const renameViaApi = async (code: string, name: string) => api.patch(`/workflow/versions/2/tasks/${code}`, { body: { name_en: name, reason: REASON }, version: await draftEtag() });
const addViaApi = async (code: string) => api.post('/workflow/versions/2/tasks', { body: { stage_code: 'MS1', code, name_en: 'Site photos', predecessors: ['A2'], reason: REASON }, version: await draftEtag() });
async function open({ lift = false, locale = 'en' as 'en' | 'ar', before }: { lift?: boolean; locale?: 'en' | 'ar'; before?: () => Promise<unknown> } = {}) {
  await signIn('pm');
  await api.post('/__mock/step-up');
  await api.post('/workflow/versions', { body: { parent_version: 1, reason: REASON } });
  if (lift) {
    const f = await api.get<{ version: number }>('/settings/structural-freeze');
    await api.post('/settings/structural-freeze/lift', { version: f.version, body: { reason: REASON, confirm_text: 'structural-freeze' } });
  }
  await before?.();
  page('/admin/settings/workflow/editor', locale);
  await screen.findByTestId('studio-tree');
  await screen.findByTestId('studio-ms-MS1');
}
const openPanel = async (u: U) => { await u.click(screen.getByTestId('studio-pending')); return screen.findByTestId('studio-pending-panel'); };
const expand = (u: U, ms: string) => u.click(screen.getByTestId(`studio-ms-toggle-${ms}`));

describe('Workflow Studio S4: pending changes with Undo', () => {
  beforeEach(() => resetWorkflowEditorMock());

  it('lists a rename in the side panel and undoes it with a reason: the parent name comes back and the count goes to zero', async () => {
    const u = userEvent.setup();
    await open({ before: () => renameViaApi('A1', 'Site acceptance report') });
    await waitFor(() => expect(screen.getByTestId('studio-pending')).toHaveTextContent('1 pending change'));
    const panel = await openPanel(u);
    expect(within(panel).getByTestId('studio-pending-title')).toHaveTextContent('Pending changes (1)');
    const row = within(panel).getByTestId('studio-pending-t_renamed:A1');
    expect(within(row).getByTestId('studio-badge-light')).toBeInTheDocument();
    expect(within(row).getByTestId('studio-pending-detail-t_renamed:A1')).toHaveTextContent(/SAR.*Site acceptance report/);
    await u.click(within(row).getByTestId('studio-undo-t_renamed:A1'));
    await reasonAndSave(u);
    await waitFor(() => expect(screen.getByTestId('studio-pending')).toHaveTextContent('0 pending changes'));
    expect(await screen.findByTestId('studio-pending-empty')).toBeInTheDocument();
    const v2 = await api.get<{ placements: { task_code: string; name_en: string }[] }>('/workflow/versions/2');
    expect(v2.placements.find((x) => x.task_code === 'A1')?.name_en).toBe('SAR');
    await u.click(screen.getByTestId('studio-pending-close'));
    expect(screen.queryByTestId('studio-pending-panel')).toBeNull();
  }, 90_000);

  it('undoes a task added in the draft through the remove door (structural, once the lock is lifted)', async () => {
    const u = userEvent.setup();
    await open({ lift: true, before: () => addViaApi('NEW1') });
    await waitFor(() => expect(screen.getByTestId('studio-pending')).toHaveTextContent('1 pending change'));
    const panel = await openPanel(u);
    const row = within(panel).getByTestId('studio-pending-t_added:NEW1');
    expect(within(row).getByTestId('studio-badge-structural')).toBeInTheDocument();
    await waitFor(() => expect(within(row).getByTestId('studio-undo-t_added:NEW1')).toBeEnabled());
    await u.click(within(row).getByTestId('studio-undo-t_added:NEW1'));
    await reasonAndSave(u);
    await waitFor(() => expect(screen.getByTestId('studio-pending')).toHaveTextContent('0 pending changes'));
    const v2 = await api.get<{ placements: { task_code: string }[] }>('/workflow/versions/2');
    expect(v2.placements.some((x) => x.task_code === 'NEW1')).toBe(false);
    expect(v2.placements.find((x) => x.task_code === 'A2')).toBeTruthy();
  }, 90_000);

  it('shows an undo as off, with the reason, while the structure is locked', async () => {
    const u = userEvent.setup();
    await open({ before: () => addViaApi('NEW1') });
    const panel = await openPanel(u);
    const btn = await within(panel).findByTestId('studio-undo-t_added:NEW1');
    expect(btn).toBeDisabled();
    expect(within(panel).getByTestId('studio-undo-why-t_added:NEW1')).toHaveTextContent(/locked until/i);
    expect(btn).toHaveAttribute('title', expect.stringMatching(/locked until/i));
  }, 60_000);

  it('brings the row back when the server refuses the undo (the version changed meanwhile: 412) and says why', async () => {
    const u = userEvent.setup();
    await open({ before: () => renameViaApi('A1', 'Changed') });
    const panel = await openPanel(u);
    await u.click(await within(panel).findByTestId('studio-undo-t_renamed:A1'));
    await u.type(await screen.findByTestId('studio-reason-dialog-reason'), REASON);
    await renameViaApi('A2', 'Changed elsewhere');
    await u.click(screen.getByTestId('studio-reason-dialog-submit'));
    expect(await screen.findByTestId('studio-reason-dialog-error')).toBeInTheDocument();
    await u.click(within(screen.getByTestId('studio-reason-dialog')).getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByTestId('studio-pending-t_renamed:A1')).toBeInTheDocument();
    const v2 = await api.get<{ placements: { task_code: string; name_en: string }[] }>('/workflow/versions/2');
    expect(v2.placements.find((x) => x.task_code === 'A1')?.name_en).toBe('Changed');
  }, 90_000);
});

describe('Workflow Studio S4: impact numbers in Review and publish', () => {
  beforeEach(() => resetWorkflowEditorMock());

  it('shows the sites, tasks added, tasks moved and dates that change as numbers from the migration preview', async () => {
    const u = userEvent.setup();
    await open({ before: () => renameViaApi('A1', 'Renamed') });
    await u.click(screen.getByTestId('studio-review-btn'));
    expect(await screen.findByTestId('studio-impact-sites')).toHaveTextContent('1');
    expect(screen.getByTestId('studio-impact-added')).toHaveTextContent('1');
    expect(screen.getByTestId('studio-impact-moved')).toHaveTextContent('0');
    expect(screen.getByTestId('studio-impact-dates')).toHaveTextContent('0');
    expect(screen.getByTestId('studio-impact')).toHaveTextContent('1 open sites');
  }, 60_000);

  it('says clearly that the server declined the preview of a draft, keeps the review usable and lets the admin try again', async () => {
    const u = userEvent.setup();
    server.use(http.post(`${API_BASE}/workflow/versions/:version/migration-preview`, () => problem(422, 'version_not_published', 'The version is a draft.')));
    await open({ before: () => renameViaApi('A1', 'Renamed') });
    await u.click(screen.getByTestId('studio-review-btn'));
    const note = await screen.findByTestId('studio-impact-refused');
    expect(note).toHaveAttribute('data-status', '422');
    expect(note).toHaveTextContent(/declined to preview/i);
    expect(screen.queryByTestId('studio-impact-counts')).toBeNull();
    expect(screen.getByTestId('studio-publish')).toBeDisabled();
    expect(screen.getByTestId('studio-review-changes')).toBeInTheDocument();
    server.resetHandlers();
    await u.click(screen.getByTestId('studio-impact-retry'));
    expect(await screen.findByTestId('studio-impact-sites')).toHaveTextContent('1');
  }, 60_000);

  it('tells a user without the right that the counts are not shown', async () => {
    const u = userEvent.setup();
    server.use(http.post(`${API_BASE}/workflow/versions/:version/migration-preview`, () => problem(403, 'action_forbidden', 'No.')));
    await open();
    await u.click(screen.getByTestId('studio-review-btn'));
    expect(await screen.findByTestId('studio-impact-refused')).toHaveTextContent(/do not have the right/i);
  }, 60_000);
});

describe('Workflow Studio S4: what the classic editor had, now in the Studio', () => {
  beforeEach(() => resetWorkflowEditorMock());

  it('marks the task that closes the milestone: one per milestone, off while the structure is locked', async () => {
    const u = userEvent.setup();
    await open({ lift: true });
    await expand(u, 'MS1');
    await u.click(screen.getByTestId('studio-task-A4'));
    const box = await screen.findByTestId('studio-closing');
    expect(screen.getByTestId('studio-form-title')).toHaveTextContent('A4');
    await waitFor(() => expect(box).toBeEnabled());
    expect(box).not.toBeChecked();
    await u.click(box);
    await reasonAndSave(u);
    expect(await screen.findByTestId('studio-closing-chip-A4')).toHaveTextContent('Closing task');
    expect(screen.getByTestId('studio-closing')).toBeChecked();
    await waitFor(() => expect(screen.getByTestId('studio-pending')).toHaveTextContent('1 pending change'));
    // the other tasks of the milestone are not closing tasks any more
    await u.click(screen.getByTestId('studio-task-A2'));
    expect(await screen.findByTestId('studio-closing')).not.toBeChecked();
  }, 90_000);

  it('keeps the closing box off while locked, with the reason', async () => {
    const u = userEvent.setup();
    await open();
    await expand(u, 'MS1');
    await u.click(screen.getByTestId('studio-task-A4'));
    const box = await screen.findByTestId('studio-closing');
    expect(box).toBeDisabled();
    expect(box).toHaveAttribute('title', expect.stringMatching(/locked until/i));
  }, 60_000);

  it('has the lock panel in the top bar: open while locked, lifts the lock, and the add menu turns on', async () => {
    const u = userEvent.setup();
    await open();
    expect(screen.getByTestId('studio-lockpanel')).toHaveAttribute('open');
    await u.click(await screen.findByTestId('freeze-lift'));
    await u.type(screen.getByTestId('freeze-dialog-reason'), REASON);
    await u.type(screen.getByTestId('freeze-confirm'), 'structural-freeze');
    await u.click(screen.getByTestId('freeze-dialog-submit'));
    await waitFor(() => expect(screen.getByTestId('freeze-status')).toHaveTextContent('lifted'));
    await expand(u, 'MS1');
    await waitFor(() => expect(screen.getByTestId('studio-add-task-MS1')).toBeEnabled());
  }, 90_000);

  it('opens the site locks shortcut from the top bar', async () => {
    const u = userEvent.setup();
    await open();
    await u.click(screen.getByTestId('studio-sitelocks-btn'));
    expect(await screen.findByTestId('wfe-sitelocks')).toBeInTheDocument();
    expect(screen.getByTestId('wfe-sitelocks-region')).toBeInTheDocument();
  }, 60_000);

  it('discards the draft with a reason and goes back to the live version', async () => {
    const u = userEvent.setup();
    await open();
    await u.click(screen.getByTestId('studio-discard'));
    await reasonAndSave(u, 'studio-discard-dialog');
    await waitFor(() => expect(screen.queryByTestId('studio-chip-draft')).toBeNull());
    expect(await screen.findByTestId('studio-create-draft')).toBeInTheDocument();
  }, 60_000);

  it('offers the site migration of a live version and no longer has a classic route', async () => {
    await signIn('pm');
    await api.post('/__mock/step-up');
    await api.post('/workflow/versions', { body: { parent_version: 1, reason: REASON } });
    await api.post('/workflow/versions/2/publish', { body: { reason: REASON, confirm_text: 'v2' }, version: await draftEtag() });
    page();
    expect(await screen.findByTestId('studio-migrate')).toBeInTheDocument();
    expect(screen.queryByTestId('studio-classic-link')).toBeNull();
  }, 60_000);

  it('renders nothing of the old editor at workflow/classic', async () => {
    await signIn('pm');
    page('/admin/settings/workflow/classic');
    await screen.findByTestId('page-settings').catch(() => undefined);
    expect(screen.queryByTestId('wfe-editor')).toBeNull();
    expect(screen.queryByTestId('studio')).toBeNull();
  }, 60_000);
});

describe('Workflow Studio S4: Arabic (RTL)', () => {
  beforeEach(() => resetWorkflowEditorMock());
  const flat = (o: object, p = ''): Record<string, string> => Object.fromEntries(Object.entries(o).flatMap(([k, v]) => (typeof v === 'object' && v ? Object.entries(flat(v, `${p}${k}.`)) : [[`${p}${k}`, String(v)]])));
  const E = flat(en), A = flat(ar);
  // technical words that stay in Latin on purpose in Arabic text
  const keep = new Set(['studio.master_col_is']);

  it('has every Studio, Studio panel and workflow-editor key in Arabic, with Arabic letters in the text', () => {
    for (const ns of ['studio.', 'studioPanel.', 'wfe.']) {
      const keys = Object.keys(E).filter((k) => k.startsWith(ns));
      expect(keys.length).toBeGreaterThan(10);
      const missing = keys.filter((k) => !(k in A));
      expect(missing, `missing in ar.json: ${missing.join(', ')}`).toEqual([]);
      const latin = keys.filter((k) => !keep.has(k) && A[k] === E[k] && /[A-Za-z]{4,}/.test(E[k]!));
      expect(latin, `not translated: ${latin.join(', ')}`).toEqual([]);
      const noArabic = keys.filter((k) => !/[؀-ۿ]/.test(A[k]!) && /[A-Za-z]{3,}/.test(E[k]!));
      expect(noArabic, `no Arabic letters: ${noArabic.join(', ')}`).toEqual([]);
    }
  });

  it('keeps the same placeholders in both languages', () => {
    const ph = (s: string) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort().join(',');
    for (const k of Object.keys(E).filter((x) => /^(studio|studioPanel)\./.test(x) && !/_(zero|one|two|few|many|other)$/.test(x))) {
      if (A[k]) expect(ph(A[k]!), k).toBe(ph(E[k]!));
    }
  });

  it('uses logical properties only in the Studio and its shared pieces (no physical margin, padding, side or text alignment classes)', () => {
    const dirs = ['settings/studio', 'settings/wf'];
    const physical = ['ml', 'mr', 'pl', 'pr', 'left', 'right'].map((x) => `-?${x}-[\\w[./]+`).concat(['text-(?:left|right)', 'border-[lr](?:-|\\b)', 'rounded-[lr](?:-|\\b)', 'float-(?:left|right)', 'space-x-', 'divide-x']);
    const bad = new RegExp(`(?<![\\w-])(?:${physical.join('|')})`);
    for (const d of dirs) {
      const dir = join(process.cwd(), 'src/pages', d);
      for (const f of readdirSync(dir).filter((x) => x.endsWith('.tsx') && !x.endsWith('.test.tsx'))) {
        const src = readFileSync(join(dir, f), 'utf8');
        for (const [i, line] of src.split('\n').entries()) if (!/^\s*(\/\*\*|\/\/|\*)/.test(line)) expect(line.match(bad)?.[0], `${d}/${f}:${i + 1}`).toBeUndefined();
      }
    }
  });

  it('shows the Studio in Arabic: mirrored chevrons, a breadcrumb without a typed ">", codes kept left to right, the panel and Undo in Arabic', async () => {
    const u = userEvent.setup();
    await open({ locale: 'ar', before: () => renameViaApi('A1', 'Renamed') });
    expect(document.documentElement.dir).toBe('rtl');
    expect(screen.getByTestId('studio-tree-title')).toHaveTextContent('سير العمل، الإصدار 2 (مسودة)');
    expect(screen.getByTestId('studio-breadcrumb').textContent).not.toMatch(/[<>]/);
    expect(screen.getByTestId('studio-breadcrumb').querySelector('svg')).toHaveClass('rtl:rotate-180');
    expect(screen.getByTestId('studio-ms-toggle-MS1').querySelector('svg')).toHaveClass('rtl:rotate-180');
    await expand(u, 'MS1');
    expect(screen.getByTestId('studio-ms-toggle-MS1').querySelector('svg')).not.toHaveClass('rtl:rotate-180');
    expect(screen.getByTestId('studio-task-A1').querySelector('[dir="ltr"]')).toHaveTextContent('A1');
    const panel = await openPanel(u);
    expect(within(panel).getByTestId('studio-undo-t_renamed:A1')).toHaveTextContent('تراجع');
    expect(within(panel).getByTestId('studio-pending-detail-t_renamed:A1').querySelector('svg')).toHaveClass('rtl:rotate-180');
    expect(panel).toHaveClass('end-0');
    expect(within(panel).getByText('A1').closest('bdi')).toHaveAttribute('dir', 'ltr');
  }, 90_000);

  it('shows the impact numbers in Arabic, each number left to right', async () => {
    const u = userEvent.setup();
    await open({ locale: 'ar', before: () => renameViaApi('A1', 'Renamed') });
    await u.click(screen.getByTestId('studio-review-btn'));
    const n = await screen.findByTestId('studio-impact-sites');
    expect(n).toHaveTextContent('1');
    expect(n.querySelector('bdi')).toHaveAttribute('dir', 'ltr');
    expect(screen.getByTestId('studio-impact-counts')).toHaveTextContent('المواقع المتأثرة');
  }, 60_000);
});

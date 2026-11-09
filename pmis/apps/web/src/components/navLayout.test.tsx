import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { resolve as path } from 'node:path';
import { Route, Routes } from 'react-router-dom';
import { Shell } from '@/components/Shell';
import {
  addMain, addSub, defaultLayout, dropOn, headRef, itemRef, keyMove, NAV_SIDE, OTHER_ID, removeHeading, resolveLayout, type Layout,
} from '@/lib/navLayout';
import { db, save } from '@/mocks/db';
import { cleanNavLayout } from '@/mocks/handlers.settings';
import { renderApp, signIn } from '@/test/utils';

/** The editable side menu (owner request 2026-11-09, contract 0.15.1, migration 0081). */
const app = (locale: 'en' | 'ar' = 'en') =>
  renderApp(<Routes><Route element={<Shell />}><Route path="*" element={<div />} /></Route></Routes>, { route: '/my-work', locale });
const store = (layout: unknown) => { db().cfg.navLayout = { layout, version: 7, updated_at: null, updated_by: null }; save(); };
const keysIn = (testid: string) => [...screen.getByTestId(testid).querySelectorAll(':scope > a, :scope > div > a, :scope > div > div > a')]
  .map((a) => a.getAttribute('data-testid')).filter((x) => x && !x.startsWith('nav-sites-'));
const editItems = (id: string) => [...screen.getByTestId(`nav-edit-heading-${id}`).querySelectorAll(':scope > ul > li[data-testid^="nav-edit-item-"]')].map((li) => li.getAttribute('data-testid')!.slice('nav-edit-item-'.length));
const key = (ref: string, k: string) => fireEvent.keyDown(screen.getByTestId(`nav-edit-handle-${ref}`), { key: k });
const live = () => screen.getByTestId('nav-edit-live').textContent ?? '';

describe('the layout model (lib/navLayout)', () => {
  it('the default is the six groups of the code with their screens in NAV order', () => {
    const d = defaultLayout();
    expect(d.headings.map((h) => h.id)).toEqual(['work', 'site_register', 'registers', 'data', 'admin', 'logs']);
    expect(d.headings[1]).toMatchObject({ name_en: 'SITE 360', name_ar: 'الموقع 360', children: ['sites', 'dismantle'] });
    expect(d.headings[0]!.children).toEqual(['my_work', 'inbox', 'approvals', 'workload', 'status_updates', 'dashboard', 'messages', 'absence']);
    expect(resolveLayout(null)).toEqual(d);
  });

  it('the catalogue of the migration lists exactly the screens of the menu (so a saved layout is never refused for a real screen)', () => {
    const read = (m: string) => readFileSync(path(process.cwd(), `../api/prisma/migrations/${m}/migration.sql`), 'utf8');
    const list = /unnest\(\s*ARRAY\[([^\]]+)\]/.exec(read('0081_nav_layout'))![1]!.match(/'([^']+)'/g)!.map((s) => s.slice(1, -1));
    // Later releases add their screens in their own migration (0082: the System Log), one INSERT ... VALUES row per key: (key, default group, ord, added_in).
    const added = [...read('0082_nav_system_log').matchAll(/INSERT INTO nav_item_catalogue[^;]*?VALUES\s*\('([^']+)',\s*'([^']+)'/g)].map((m) => ({ key: m[1]!, group: m[2]! }));
    expect(added).toEqual([{ key: 'logs.system', group: 'logs' }]);
    expect([...list, ...added.map((a) => a.key)].sort()).toEqual(NAV_SIDE.map((n) => n.key).sort());
    for (const a of added) expect(NAV_SIDE.find((n) => n.key === a.key)?.group).toBe(a.group);
    expect(cleanNavLayout(defaultLayout()).errors).toEqual([]);
  });

  it('drops unknown and repeated keys, appends a new screen of the code at the end of its default heading, or to Other when that heading is gone', () => {
    const saved = {
      headings: [
        { id: 'logs', name_en: 'Logs', name_ar: 'السجلات', icon: 'audit', children: ['logs.mail', 'gone_screen', 'logs.mail'] },
        { id: 'mine', name_en: 'Mine', name_ar: 'لي', icon: 'nope', children: [{ id: 'sub', name_en: 'Sub', name_ar: 'فرعي', icon: null, children: ['inbox', 'old_key'] }] },
      ],
    };
    const r = resolveLayout(saved);
    const logs = r.headings.find((h) => h.id === 'logs')!;
    expect(logs.icon).toBe('audit');
    expect(logs.children[0]).toBe('logs.mail');
    expect(logs.children.filter((c) => c === 'logs.mail')).toHaveLength(1);
    expect(logs.children).not.toContain('gone_screen');
    expect(logs.children.at(-1)).toBe('logs.integrity'); // missing from the saved layout: appended, in NAV order
    expect(r.headings.find((h) => h.id === 'mine')!.icon).toBeNull(); // an icon the code does not know is ignored
    expect(r.headings.find((h) => h.id === 'mine')!.children[0]).toEqual({ id: 'sub', name_en: 'Sub', name_ar: 'فرعي', icon: null, children: ['inbox'] });
    const other = r.headings.find((h) => h.id === OTHER_ID)!;
    expect(other).toMatchObject({ name_en: 'Other', name_ar: 'أخرى' });
    expect(other.children).toContain('my_work'); // its heading "work" was not saved
    const all = r.headings.flatMap((h) => h.children.flatMap((c) => (typeof c === 'string' ? [c] : c.children)));
    expect([...all].sort()).toEqual(NAV_SIDE.map((n) => n.key).sort()); // every screen exactly once
  });

  it('moves with the keyboard: into and out of a sub-heading, across main headings, and stops at the ends', () => {
    let l: Layout = addSub(defaultLayout(), 'work', { name_en: 'Talk', name_ar: 'تواصل', icon: null });
    const sub = (l.headings[0]!.children.at(-1) as { id: string }).id;
    l = keyMove(l, itemRef('absence'), 1)!; // the last item steps into the sub-heading below it
    expect(l.headings[0]!.children.at(-1)).toMatchObject({ id: sub, children: ['absence'] });
    l = keyMove(l, itemRef('absence'), 1)!; // out of the sub-heading, after it
    expect(l.headings[0]!.children.at(-1)).toBe('absence');
    l = keyMove(l, itemRef('absence'), 1)!; // into the next main heading, first
    expect(l.headings[1]!.children[0]).toBe('absence');
    expect(keyMove(l, headRef('work'), -1)).toBeNull();
    expect(keyMove(l, headRef('logs'), 1)).toBeNull();
    expect(keyMove(l, headRef('logs'), -1)!.headings.map((h) => h.id).slice(-2)).toEqual(['logs', 'admin']);
    const s2 = keyMove(l, headRef(sub), 1)!; // a sub-heading moves to the next main heading
    expect(s2.headings[1]!.children[0]).toMatchObject({ id: sub });
  });

  it('drops with the pointer: reorders, moves into another heading or sub-heading, moves a sub-heading under another main heading, never into itself', () => {
    let l = addSub(defaultLayout(), 'registers', { name_en: 'Power', name_ar: 'الطاقة', icon: 'power' });
    const sub = (l.headings[2]!.children.at(-1) as { id: string }).id;
    l = dropOn(l, itemRef('gecol'), `end:${sub}`)!;
    expect(l.headings[2]!.children).not.toContain('gecol');
    expect(l.headings[2]!.children.at(-1)).toMatchObject({ children: ['gecol'] });
    l = dropOn(l, itemRef('my_work'), itemRef('approvals'))!; // the same list: takes the place of the target
    expect(l.headings[0]!.children.slice(0, 3)).toEqual(['inbox', 'approvals', 'my_work']);
    l = dropOn(l, itemRef('templates'), itemRef('sites'))!; // another list: before the target
    expect(l.headings[1]!.children).toEqual(['templates', 'sites', 'dismantle']);
    l = dropOn(l, headRef(sub), headRef('logs'))!;
    expect(l.headings[5]!.children.at(-1)).toMatchObject({ id: sub });
    expect(dropOn(l, headRef(sub), itemRef('gecol'))).toBeNull();
    expect(dropOn(l, headRef('work'), headRef('logs'))!.headings.map((h) => h.id).at(-1)).toBe('work');
  });

  it('deleting a heading never deletes a screen: a sub-heading gives its screens to its main heading, a main heading to Other', () => {
    let l = addSub(defaultLayout(), 'admin', { name_en: 'People', name_ar: 'الأشخاص', icon: null });
    const sub = (l.headings[4]!.children.at(-1) as { id: string }).id;
    l = dropOn(l, itemRef('admin.users'), `end:${sub}`)!;
    l = removeHeading(l, sub)!;
    expect(l.headings[4]!.children).toEqual(['admin.settings', 'announcements', 'admin.users']);
    l = removeHeading(l, 'admin')!;
    expect(l.headings.at(-1)).toMatchObject({ id: OTHER_ID, children: ['admin.settings', 'announcements', 'admin.users'] });
    expect(removeHeading(l, OTHER_ID)).toBeNull(); // Other with screens stays
    expect(addMain(l, { name_en: 'X', name_ar: 'س', icon: null }).headings.at(-1)!.id).toMatch(/^h\d+$/);
  });
});

describe('the side menu with a shared layout', () => {
  it('shows the default when nothing is saved, and no Edit menu button to a user who may not edit it', async () => {
    await signIn('engineer');
    app();
    await screen.findByTestId('nav-sites');
    expect(screen.queryByTestId('nav-edit')).not.toBeInTheDocument();
    expect(screen.queryByTestId('nav-group-registers')).not.toBeInTheDocument();
  });

  it('applies the permission filter after the layout: hidden screens stay hidden and a heading with no open screen is hidden', async () => {
    store({ headings: [
      { id: 'mix', name_en: 'Mixed', name_ar: 'مختلط', icon: 'site', children: ['warehouse', 'sites'] },
      { id: 'regs', name_en: 'Only registers', name_ar: 'سجلات فقط', icon: null, children: ['procurement', 'quality', { id: 'deep', name_en: 'Deep', name_ar: 'عميق', icon: null, children: ['issues'] }] },
    ] });
    await signIn('engineer');
    app();
    await screen.findByTestId('nav-sites');
    expect(screen.getByTestId('nav-group-toggle-mix')).toHaveTextContent('Mixed');
    expect(screen.queryByTestId('nav-warehouse')).not.toBeInTheDocument();
    expect(screen.queryByTestId('nav-group-regs')).not.toBeInTheDocument();
    expect(screen.queryByTestId('nav-group-deep')).not.toBeInTheDocument();
    // the screens missing from the saved layout come back (here in Other)
    expect(screen.getByTestId('nav-group-other')).toContainElement(screen.getByTestId('nav-my_work')); // its default heading is not in the layout
  });

  it('renders a saved layout with its sub-headings and the Arabic names in RTL', async () => {
    store({ headings: [
      { id: 'day', name_en: 'My day', name_ar: 'يومي', icon: 'home', children: ['dashboard', { id: 'talk', name_en: 'Talk', name_ar: 'تواصل', icon: null, children: ['messages', 'inbox'] }, 'my_work'] },
    ] });
    await signIn('pm');
    app('ar');
    await screen.findByTestId('nav-group-day');
    expect(document.documentElement.dir).toBe('rtl');
    expect(screen.getByTestId('nav-group-toggle-day')).toHaveTextContent('يومي');
    expect(screen.getByTestId('nav-group-toggle-talk')).toHaveTextContent('تواصل');
    const day = screen.getByTestId('nav-group-day');
    expect(within(day).getByTestId('nav-group-talk')).toContainElement(screen.getByTestId('nav-inbox'));
    expect(keysIn('nav-group-day')).toEqual(['nav-dashboard', 'nav-messages', 'nav-inbox', 'nav-my_work']);
    expect(screen.getByTestId('nav-edit')).toHaveTextContent('تعديل القائمة');
  });

  it('a System Admin reorders with the keyboard (Space, arrows, Space), with announcements, and saves with a reason for everyone', async () => {
    const u = userEvent.setup();
    await signIn('pm');
    app();
    await u.click(await screen.findByTestId('nav-edit'));
    expect(screen.getByTestId('nav-editor')).toBeInTheDocument();
    expect(editItems('work').slice(0, 3)).toEqual(['my_work', 'inbox', 'approvals']);
    key('i:approvals', ' ');
    expect(live()).toMatch(/Approvals picked up: position 3 of 8 in Work/);
    key('i:approvals', 'ArrowUp');
    key('i:approvals', 'ArrowUp');
    expect(live()).toMatch(/Approvals: position 1 of 8 in Work/);
    key('i:approvals', ' ');
    expect(live()).toMatch(/Approvals dropped at position 1 of 8 in Work/);
    expect(editItems('work').slice(0, 3)).toEqual(['approvals', 'my_work', 'inbox']);
    expect(screen.getByTestId('nav-edit-handle-i:approvals')).toHaveFocus();
    // Escape puts a move back
    key('i:inbox', ' ');
    key('i:inbox', 'ArrowDown');
    key('i:inbox', 'Escape');
    expect(live()).toMatch(/Move cancelled/);
    expect(editItems('work').slice(0, 3)).toEqual(['approvals', 'my_work', 'inbox']);
    // a main heading moves among the main headings
    key('h:logs', ' ');
    key('h:logs', 'ArrowUp');
    key('h:logs', 'Enter');
    expect([...screen.getByTestId('nav-edit-tree').children].map((li) => li.getAttribute('data-testid'))).toEqual(
      ['work', 'site_register', 'registers', 'data', 'logs', 'admin'].map((id) => `nav-edit-heading-${id}`));

    await u.click(screen.getByTestId('nav-edit-save'));
    const dlg = await screen.findByTestId('nav-edit-confirm');
    await u.click(within(dlg).getByTestId('nav-edit-confirm-submit'));
    expect(within(dlg).getByTestId('nav-edit-confirm-reason-error')).toBeInTheDocument(); // the reason is required
    await u.type(within(dlg).getByTestId('nav-edit-confirm-reason'), 'Approvals first, as the owner asked');
    await u.click(within(dlg).getByTestId('nav-edit-confirm-submit'));
    await waitFor(() => expect(screen.queryByTestId('nav-editor')).not.toBeInTheDocument());
    expect(keysIn('nav-group-work').slice(0, 3)).toEqual(['nav-approvals', 'nav-my_work', 'nav-inbox']);
    expect((db().cfg.navLayout.layout as Layout).headings[0]!.children.slice(0, 2)).toEqual(['approvals', 'my_work']);
    expect(db().cfg.navLayout.version).toBe(2);
  }, 30_000);

  it('adds a main heading and a sub-heading (EN and AR required), moves a screen into it, deletes a heading (its screens move up) and cancels nothing saved', async () => {
    const u = userEvent.setup();
    await signIn('pm');
    app();
    await u.click(await screen.findByTestId('nav-edit'));
    await u.click(screen.getByTestId('nav-edit-add-main'));
    let dlg = await screen.findByTestId('nav-heading-dialog');
    await u.type(within(dlg).getByTestId('nav-heading-en'), 'Field work');
    await u.click(within(dlg).getByTestId('nav-heading-dialog-submit'));
    expect(within(dlg).getByTestId('nav-heading-error')).toHaveTextContent('English and in Arabic');
    await u.type(within(dlg).getByTestId('nav-heading-ar'), 'العمل الميداني');
    await u.selectOptions(within(dlg).getByTestId('nav-heading-icon'), 'site');
    await u.click(within(dlg).getByTestId('nav-heading-dialog-submit'));
    await waitFor(() => expect(screen.queryByTestId('nav-heading-dialog')).not.toBeInTheDocument());
    expect(screen.getByTestId('nav-edit-name-h7')).toHaveTextContent('Field work');

    await u.click(screen.getByTestId('nav-edit-add-sub-h7'));
    dlg = await screen.findByTestId('nav-heading-dialog');
    await u.type(within(dlg).getByTestId('nav-heading-en'), 'Power');
    await u.type(within(dlg).getByTestId('nav-heading-ar'), 'الطاقة');
    await u.click(within(dlg).getByTestId('nav-heading-dialog-submit'));
    await waitFor(() => expect(screen.getByTestId('nav-edit-heading-h8')).toHaveAttribute('data-depth', '2'));

    // move "Mail delivery" (last of Logs) down: into the next main heading (Field work), then into its sub-heading Power
    key('i:logs.mail', ' ');
    key('i:logs.mail', 'ArrowDown');
    expect(live()).toMatch(/in Field work/);
    key('i:logs.mail', 'ArrowDown');
    expect(live()).toMatch(/in Power/);
    key('i:logs.mail', ' ');
    expect(screen.getByTestId('nav-edit-heading-h8')).toContainElement(screen.getByTestId('nav-edit-item-logs.mail'));

    // deleting the sub-heading moves its screen to the main heading; deleting the main heading moves it to Other
    await u.click(screen.getByTestId('nav-edit-delete-h8'));
    expect(editItems('h7')).toEqual(['logs.mail']);
    await u.click(screen.getByTestId('nav-edit-delete-h7'));
    expect(editItems(OTHER_ID)).toEqual(['logs.mail']);
    expect(live()).toMatch(/moved to Other/);
    expect(screen.getByTestId('nav-edit-delete-other')).toBeDisabled();

    await u.click(screen.getByTestId('nav-edit-cancel'));
    expect(screen.queryByTestId('nav-editor')).not.toBeInTheDocument();
    expect(screen.queryByTestId('nav-group-other')).not.toBeInTheDocument();
    expect(db().cfg.navLayout.layout).toBeNull();
  }, 30_000);

  it('resets a saved layout to the default with a reason', async () => {
    const u = userEvent.setup();
    store({ headings: [{ id: 'only', name_en: 'Everything', name_ar: 'كل شيء', icon: null, children: ['inbox'] }] });
    await signIn('pm');
    app();
    await screen.findByTestId('nav-group-only');
    await u.click(screen.getByTestId('nav-edit'));
    await u.click(screen.getByTestId('nav-edit-reset'));
    const dlg = await screen.findByTestId('nav-edit-confirm');
    await u.type(within(dlg).getByTestId('nav-edit-confirm-reason'), 'Back to the system order');
    await u.click(within(dlg).getByTestId('nav-edit-confirm-submit'));
    await waitFor(() => expect(screen.queryByTestId('nav-group-only')).not.toBeInTheDocument());
    expect(screen.getByTestId('nav-group-work')).toBeInTheDocument();
    expect(db().cfg.navLayout.layout).toBeNull();
  }, 30_000);

  it('the editor works in Arabic', async () => {
    const u = userEvent.setup();
    await signIn('pm');
    app('ar');
    await u.click(await screen.findByTestId('nav-edit'));
    expect(screen.getByTestId('nav-edit-add-main')).toHaveTextContent('إضافة عنوان رئيسي');
    expect(screen.getByTestId('nav-edit-name-registers')).toHaveTextContent('السجلات والقيود');
    key('i:inbox', ' ');
    expect(live()).toMatch(/^التُقط/);
    key('i:inbox', 'Escape');
  }, 30_000);
});

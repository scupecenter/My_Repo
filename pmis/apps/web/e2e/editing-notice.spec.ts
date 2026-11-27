import { expect, test } from '@playwright/test';
import { login } from './helpers';

// 0.15.246 (item 17): the soft "… is editing this record" notice in the register record editor, EN/light and AR/dark (RTL).
// The other editor is faked at the network edge so the notice shows for the screenshot; the heartbeat and the list flow are covered by
// the api and component tests.
for (const c of [{ locale: 'en', theme: 'light', suffix: 'en' }, { locale: 'ar', theme: 'dark', suffix: 'ar' }] as const) {
  test(`editing notice (${c.suffix})`, async ({ page }) => {
    await page.addInitScript(([l, t]) => { localStorage.setItem('pmis.locale', l); localStorage.setItem('pmis.theme', t); }, [c.locale, c.theme]);
    await login(page, 'pm');
    await page.goto('/registers/procurement');
    await expect(page.getByTestId('saved-views')).toBeVisible();
    const id = await page.evaluate(async () => {
      const r = await fetch('/api/v1/registers/procurement/records?limit=1');
      const j = (await r.json()) as { items: { id: string }[] };
      return j.items[0]!.id;
    });
    await page.evaluate(async (rid) => {
      await fetch('/api/v1/__mock/presence-seed', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'record', entity_id: rid, name: 'Demo User 02' }) });
    }, id);
    await page.goto(`/registers/procurement?record=${id}`);
    const notice = page.getByTestId('reg-editing-notice');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('Demo User 02');
    await page.screenshot({ path: `test-results/pres-1-notice-${c.suffix}.png`, fullPage: false });
  });

  // Item 17 widened: the same notice in the task drawer (kind `task`). SB128 has B9 in entry, editable by the pm.
  test(`editing notice on a task (${c.suffix})`, async ({ page }) => {
    await page.addInitScript(([l, t]) => { localStorage.setItem('pmis.locale', l); localStorage.setItem('pmis.theme', t); localStorage.setItem('pmis.site.layout', '"list"'); }, [c.locale, c.theme]);
    await login(page, 'pm');
    const site = '50000000-0000-4000-8000-000000000028';
    await page.goto(`/sites/${site}`);
    await expect(page.getByTestId('pipeline')).toBeVisible();
    const id = await page.evaluate(async (sid) => {
      const r = await fetch(`/api/v1/sites/${sid}/tasks`);
      const j = (await r.json()) as { stages: { tasks: { id: string; task_code: string }[] }[] };
      return j.stages.flatMap((s) => s.tasks).find((t) => t.task_code === 'B9')!.id;
    }, site);
    await page.evaluate(async (tid) => {
      await fetch('/api/v1/__mock/presence-seed', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'task', entity_id: tid, name: 'Demo User 02' }) });
    }, id);
    await page.goto(`/sites/${site}?task=${id}`);
    const notice = page.getByTestId('task-editing-notice');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('Demo User 02');
    await page.screenshot({ path: `test-results/pres-2-task-${c.suffix}.png` });
  });
}

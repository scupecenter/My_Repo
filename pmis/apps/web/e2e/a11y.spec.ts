import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { login } from './helpers';

// Accessibility gate (axe-core): the main screens, EN/light and AR/dark, against the mock layer. The test fails on violations of impact
// "serious" or "critical" only; "moderate" and "minor" are printed in the log and do not fail. Each failure names the rule, the count and
// the first selectors so it can be fixed without a rerun. Tags: WCAG 2.0 and 2.1 level A and AA.
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function scan(page: Page, name: string) {
  const res = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const soft = res.violations.filter((v) => v.impact === 'moderate' || v.impact === 'minor');
  if (soft.length) console.log(`a11y ${name}: ${soft.length} moderate/minor: ${soft.map((v) => `${v.id}(${v.nodes.length})`).join(', ')}`);
  const hard = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  const report = hard.map((v) => `${v.impact} ${v.id} x${v.nodes.length}: ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join('\n    ')}`);
  expect(report, `${name}\n${report.join('\n')}`).toEqual([]);
}

const PAGES: { name: string; path: string; testid: string }[] = [
  { name: 'dashboard', path: '/dashboard', testid: 'page-dashboard' },
  { name: 'site-master', path: '/sites', testid: 'page-sites' },
  { name: 'approvals', path: '/approvals', testid: 'page-approvals' },
  { name: 'data-hub', path: '/data-hub', testid: 'page-data-hub' },
];

for (const c of [{ locale: 'en', theme: 'light' }, { locale: 'ar', theme: 'dark' }] as const) {
  test(`a11y: sign-in page (${c.locale}/${c.theme})`, async ({ page }) => {
    await page.addInitScript(([l, t]) => { localStorage.setItem('pmis.locale', l); localStorage.setItem('pmis.theme', t); }, [c.locale, c.theme]);
    await page.goto('/login');
    await expect(page.getByTestId('login-submit')).toBeVisible();
    await scan(page, `login ${c.locale}/${c.theme}`);
  });

  test(`a11y: main screens (${c.locale}/${c.theme})`, async ({ page }) => {
    await page.addInitScript(([l, t]) => { localStorage.setItem('pmis.locale', l); localStorage.setItem('pmis.theme', t); }, [c.locale, c.theme]);
    await login(page, 'pm');
    for (const p of PAGES) {
      await page.goto(p.path);
      await expect(page.getByTestId(p.testid)).toBeVisible();
      await page.waitForLoadState('networkidle');
      await scan(page, `${p.name} ${c.locale}/${c.theme}`);
    }
  });
}

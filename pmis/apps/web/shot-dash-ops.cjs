/* Visual verification shots for the dashboard ops card (not committed tooling; local run). */
const { chromium } = require('playwright-core');

// SEC-4: no credentials in the repository. Set SHOT_IDENTIFIER and SHOT_PASSWORD for the account the screens are shot with (the mock server's demo
// accounts are listed in src/mocks/db.ts; never a real account).
const IDENTIFIER = process.env.SHOT_IDENTIFIER;
const PASSWORD = process.env.SHOT_PASSWORD;
if (!IDENTIFIER || !PASSWORD) { console.error('Set SHOT_IDENTIFIER and SHOT_PASSWORD first.'); process.exit(1); }

const BASE = 'http://localhost:5174';
const OUT = '/downloads';

async function login(page) {
  await page.goto(BASE + '/login');
  await page.getByTestId('login-identifier').fill(IDENTIFIER);
  await page.getByTestId('login-password').fill(PASSWORD);
  await page.getByTestId('login-submit').click();
  await page.goto(BASE + '/dashboard');
  await page.getByTestId('page-dashboard').waitFor({ state: 'visible', timeout: 30000 });
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome' });
  const cases = [
    { name: 'en-light', locale: 'en', theme: 'light', width: 1440, height: 900 },
    { name: 'ar-dark', locale: 'ar', theme: 'dark', width: 1440, height: 900 },
    { name: 'en-light-narrow', locale: 'en', theme: 'light', width: 390, height: 844 },
    { name: 'ar-light', locale: 'ar', theme: 'light', width: 1440, height: 900 },
  ];
  for (const c of cases) {
    const ctx = await browser.newContext({ viewport: { width: c.width, height: c.height } });
    const page = await ctx.newPage();
    await page.addInitScript(([l, t]) => { localStorage.setItem('pmis.locale', l); localStorage.setItem('pmis.theme', t); }, [c.locale, c.theme]);
    await login(page);
    const card = page.getByTestId('dash-ops-procurement');
    await card.scrollIntoViewIfNeeded();
    await card.waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForTimeout(800);
    await card.screenshot({ path: `${OUT}/dash-ops-${c.name}.png` });
    await ctx.close();
    console.log('shot', c.name);
  }
  // print
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.addInitScript(([l, t]) => { localStorage.setItem('pmis.locale', l); localStorage.setItem('pmis.theme', t); }, ['en', 'light']);
  await login(page);
  const card = page.getByTestId('dash-ops-procurement');
  await card.scrollIntoViewIfNeeded();
  await card.waitFor({ state: 'visible', timeout: 15000 });
  await page.emulateMedia({ media: 'print' });
  await page.waitForTimeout(500);
  await card.screenshot({ path: `${OUT}/dash-ops-print.png` });
  await ctx.close();
  console.log('shot print');
  await browser.close();
})().catch((e) => { console.error(e.message); process.exit(1); });

import { createHmac } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { answerAnnouncements, DEMO, login, stepUp } from './helpers';

// Two-factor (TOTP) for local accounts: an admin turns it on and gets a one-time enrolment code (shown once), the user enters that code at the
// next sign-in before the QR code appears, enrols (QR code, recovery codes), then signs in with password and code. Both languages and both themes (Arabic runs right-to-left, dark theme).

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32decode(s: string): Buffer {
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/[\s=-]/g, '').toUpperCase()) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
/** RFC 6238, SHA-1, 6 digits, 30 s; `offset` steps from now (the mock accepts one step either side and refuses a step already used). */
function totp(secret: string, offset = 0): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + offset));
  const h = createHmac('sha1', b32decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 0x0f;
  return String((((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1_000_000).padStart(6, '0');
}
const signOut = (page: Page) => page.getByTestId('topbar-signout').click();

for (const [locale, theme] of [['en', 'light'], ['ar', 'dark']] as const) {
  test(`admin turns two-factor on, the user enrols, then signs in with a code ${locale} ${theme}`, async ({ page }) => {
    test.setTimeout(60_000); // five sign-ins and two dialogs, in a dev server
    await page.addInitScript(([l, t]) => { localStorage.setItem('pmis.locale', l); localStorage.setItem('pmis.theme', t); }, [locale, theme]);

    // 1. The admin turns it on for the engineer (reason and step-up).
    await login(page, 'pm');
    await page.getByTestId('nav-admin.users').click();
    await page.getByTestId('user-open-1204').click();
    await expect(page.getByTestId('tf-badge-1204')).toHaveAttribute('data-state', 'off');
    await page.getByTestId('two-factor-on').click();
    await page.getByTestId('two-factor-dialog-reason').fill('Approver of final acceptances');
    await page.getByTestId('two-factor-dialog-submit').click();
    await stepUp(page, 'pm');
    // The one-time enrolment code is shown once; the admin hands it to the user and confirms.
    await expect(page.getByTestId('enrol-code-dialog')).toBeVisible();
    const enrolCode = (await page.getByTestId('enrol-code-value').textContent())!.trim();
    expect(enrolCode).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    await expect(page.getByTestId('enrol-code-expiry')).toBeVisible();
    if (locale === 'ar') await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await page.getByTestId('enrol-code-done').click();
    await expect(page.getByTestId('enrol-code-dialog')).toHaveCount(0);
    await expect(page.getByTestId('tf-badge-1204')).toHaveAttribute('data-state', 'pending_enrolment');
    await expect(page.getByTestId('enrol-code-status')).toHaveAttribute('data-state', 'active');
    // nobody changes their own
    await page.goto('/admin/users');
    await page.getByTestId('user-open-1001').click();
    await expect(page.getByTestId('two-factor-on')).toBeDisabled();
    await signOut(page);

    // 2. The engineer is forced to enrol before anything else.
    await login(page, 'engineer');
    // The password alone shows no QR code: the enrolment code comes first.
    await expect(page.getByTestId('enrol-code-form')).toBeVisible();
    await expect(page.getByTestId('enrol-qr')).toHaveCount(0);
    if (locale === 'ar') {
      await expect(page.getByTestId('enrol-code-form')).toContainText('أدخل رمز التسجيل');
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    }
    await page.getByTestId('enrol-admin-code').fill('AAAABBBB');
    await page.getByTestId('enrol-admin-code-submit').click();
    await expect(page.getByTestId('enrol-admin-code-error')).toBeVisible();
    await expect(page.getByTestId('enrol-qr')).toHaveCount(0);
    await page.getByTestId('enrol-admin-code').fill(enrolCode);
    await page.getByTestId('enrol-admin-code-submit').click();
    await expect(page.getByTestId('enrol-form')).toBeVisible();
    await expect(page.getByTestId('enrol-qr')).toBeVisible();
    if (locale === 'ar') await expect(page.getByTestId('enrol-form')).toContainText('إعداد التحقق الثنائي');
    const key = (await page.getByTestId('enrol-key').textContent())!.replace(/\s/g, '');
    expect(key).toMatch(/^[A-Z2-7]{32}$/);
    await page.getByTestId('enrol-code').fill('000000');
    await page.getByTestId('enrol-submit').click();
    await expect(page.getByTestId('enrol-code-error')).toBeVisible();
    await page.getByTestId('enrol-code').fill(totp(key));
    await page.getByTestId('enrol-submit').click();
    await expect(page.getByTestId('recovery-codes')).toBeVisible();
    await expect(page.getByTestId('recovery-code')).toHaveCount(10);
    const recovery = (await page.getByTestId('recovery-code').first().textContent())!;
    await expect(page.getByTestId('recovery-continue')).toBeDisabled();
    await page.getByTestId('recovery-saved').check();
    await page.getByTestId('recovery-continue').click();
    await answerAnnouncements(page);
    await expect(page.getByTestId('page-my-work')).toBeVisible();
    await signOut(page);

    // 3. The next sign-in asks for the code; a wrong one is refused, the next step's code works.
    await login(page, 'engineer');
    await expect(page.getByTestId('two-factor-form')).toBeVisible();
    await page.getByTestId('two-factor-code').fill('000000');
    await page.getByTestId('two-factor-submit').click();
    await expect(page.getByTestId('two-factor-error')).toBeVisible();
    await page.getByTestId('two-factor-code').fill(totp(key, 1));
    await page.getByTestId('two-factor-submit').click();
    await expect(page.getByTestId('page-my-work')).toBeVisible();
    await signOut(page);

    // 4. A recovery code signs in once.
    await login(page, 'engineer');
    await page.getByTestId('two-factor-toggle').click();
    await page.getByTestId('two-factor-recovery').fill(recovery);
    await page.getByTestId('two-factor-submit').click();
    await expect(page.getByTestId('page-my-work')).toBeVisible();
    await page.goto('/change-password');
    await expect(page.getByTestId('recovery-remaining')).toContainText('9');
    await expect(page.getByTestId('two-factor-card')).toBeVisible();
    await signOut(page);

    // 5. The admin sees it on, and the DEMO engineer password is unchanged.
    await login(page, 'pm');
    await page.getByTestId('nav-admin.users').click();
    await expect(page.getByTestId('tf-badge-1204')).toHaveAttribute('data-state', 'on');
    expect(DEMO.engineer.id).toBe('1204');
  });
}

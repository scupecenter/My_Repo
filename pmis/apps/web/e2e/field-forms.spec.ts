import { expect, test } from '@playwright/test';
import { login, stepUp } from './helpers';

// Offline field forms: an admin defines a form kind in Settings, a field user fills it on the Field screen, draws the signature and the form is queued, then sent. EN, AR, and a 390px phone.
for (const c of [{ locale: 'en', w: 1280 }, { locale: 'ar', w: 1280 }, { locale: 'en', w: 390 }] as const) {
  test(`field forms follow their settings (${c.locale}, ${c.w}px)`, async ({ page }) => {
    await page.setViewportSize({ width: c.w, height: 900 });
    await page.addInitScript((l) => { if (!localStorage.getItem('pmis.locale')) localStorage.setItem('pmis.locale', l); }, c.locale);
    await login(page, 'pm');
    // Field mode on
    await page.goto('/admin/settings/screens/field-mode');
    const on = page.getByTestId('fps-enabled');
    await on.waitFor();
    if (!(await on.isChecked())) await on.check({ force: true });
    await page.getByTestId('fps-save').click();
    await page.getByTestId('fps-dialog-reason').fill('Field forms pilot');
    await page.getByTestId('fps-dialog-submit').click();
    await stepUp(page);
    await expect(page.getByTestId('toast').first()).toBeVisible();
    // a form kind with a required field and a signature
    await page.evaluate(() => { history.pushState({}, '', '/admin/settings/screens/field-forms'); dispatchEvent(new PopStateEvent('popstate')); });
    await page.getByTestId('ffset-form-add').click();
    await page.getByTestId('ffset-form-0-code').fill('handover');
    await page.getByTestId('ffset-form-0-en').fill('Handover');
    await page.getByTestId('ffset-form-0-ar').fill('تسليم');
    await page.getByTestId('ffset-form-0-signature').check({ force: true });
    await page.getByTestId('ffset-form-0-field-add').click();
    await page.getByTestId('ffset-field-0-0-key').fill('note');
    await page.getByTestId('ffset-field-0-0-en').fill('Note');
    await page.getByTestId('ffset-field-0-0-ar').fill('ملاحظة');
    await page.getByTestId('ffset-field-0-0-required').check({ force: true });
    await page.getByTestId('ffset-save').click();
    await page.getByTestId('ffset-dialog-reason').fill('Handover form');
    await page.getByTestId('ffset-dialog-submit').click();
    await stepUp(page);
    await expect(page.getByTestId('toast').first()).toBeVisible();
    // the Field screen (in-app: the mock keeps its state until a reload)
    await page.evaluate(() => { history.pushState({}, '', '/field'); dispatchEvent(new PopStateEvent('popstate')); });
    await expect(page.getByTestId('page-field')).toBeVisible();
    const site = page.getByTestId('field-site');
    await site.waitFor();
    await site.selectOption({ index: 1 });
    await page.getByTestId('field-form-kind').selectOption('handover');
    await page.getByTestId('field-form-queue').click();
    await expect(page.getByTestId('field-form-sig-err')).toBeVisible();
    await page.getByTestId('ff-note').fill('All clear');
    await page.getByTestId('ff-signer').fill('Ali Hassan');
    const box = (await page.getByTestId('sigpad-canvas').boundingBox())!;
    await page.mouse.move(box.x + 20, box.y + 20);
    await page.mouse.down();
    await page.mouse.move(box.x + 80, box.y + 50, { steps: 5 });
    await page.mouse.move(box.x + 120, box.y + 30, { steps: 5 });
    await page.mouse.up();
    await expect(page.getByTestId('sigpad-canvas')).toHaveAttribute('data-strokes', '1');
    await page.screenshot({ path: `test-results/field-forms-${c.locale}-${c.w}.png` });
    await page.getByTestId('field-form-queue').click();
    await expect(page.getByTestId('field-form-sent').first()).toBeVisible();
  });
}

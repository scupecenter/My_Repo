import { expect, test } from '@playwright/test';
import { login } from './helpers';

// Item 9: the group header of My Work shows the count and a status distribution bar; a segment filters, the Layout panel turns the bar off. EN and AR.
for (const c of [{ locale: 'en' }, { locale: 'ar' }] as const) {
  test(`group summary on My Work: bar, filter by segment, switch off in the Layout panel (${c.locale})`, async ({ page }) => {
    await page.addInitScript((l) => { localStorage.setItem('pmis.locale', l); }, c.locale);
    await login(page, 'pm');
    await page.goto('/my-work');
    const sum = page.getByTestId('my-work-summary-do_now');
    await expect(sum).toBeVisible();
    await expect(page.getByTestId('my-work-summary-do_now-bar')).toBeVisible();
    await expect(page.getByTestId('my-work-summary-do_now-text').locator('li').first()).toBeAttached();
    await page.screenshot({ path: `test-results/group-summary-${c.locale}.png` });

    const seg = sum.locator('button[data-testid*="-seg-"]').first();
    const before = Number(await page.getByTestId('my-work-count-do_now').textContent());
    await seg.click();
    await expect(seg).toHaveAttribute('aria-pressed', 'true');
    await expect(page).toHaveURL(/sla=/);
    const after = Number(await page.getByTestId('my-work-count-do_now').textContent());
    expect(after).toBeLessThanOrEqual(before);
    await page.getByTestId('my-work-summary-do_now-clear').click();
    await expect(page).not.toHaveURL(/sla=/);

    await page.getByTestId('my-work-view').click();
    await expect(page.getByTestId('display-groupbar')).toBeChecked();
    await page.getByTestId('display-groupbar').uncheck();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('my-work-summary-do_now')).toHaveCount(0);
    // the person's own choice is per screen: put it back so the shared user is left as found
    await page.getByTestId('my-work-view').click();
    await page.getByTestId('display-groupbar').check();
    await expect(page.getByTestId('my-work-summary-do_now')).toBeVisible();
  });
}

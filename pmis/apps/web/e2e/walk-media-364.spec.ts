import { expect, test, type Page } from '@playwright/test';

// Real-stack walkthrough of PR #364 (Library > Media + Settings > Documents > Media). Throwaway: the findings and screenshots go to the PR
// as a comment; nothing here is committed. Run only with WALK=1.
test.skip(!process.env.WALK, 'real-stack run only');

// A real 400x300 PNG (generated with PIL) so the upload is a true photo for the thumbnail pipeline.
import { readFileSync } from 'node:fs';
const PNG = readFileSync('/tmp/walk-photo.png');

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByTestId('login-identifier').fill('9001');
  await page.getByTestId('login-password').fill('Walk-Admin-Pass-2026');
  await page.getByTestId('login-submit').click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 });
}

test('media walk #364: upload, gallery list, filters, settings, EN and AR', async ({ page }) => {
  await signIn(page);
  const session = await (await page.request.get('/api/v1/auth/session')).json();
  const csrf = { 'X-CSRF-Token': session.csrf_token as string };

  // Content: a financial advance (the scratch DB has no sites; the only placed library document types are ADV_PROOF on advance records),
  // its ADV_PROOF slot, and a real PNG uploaded into the slot.
  const defs = await (await page.request.get('/api/v1/registers')).json();
  const def = defs.items.find((d: { register_key: string }) => d.register_key === 'financial_advances');
  const data: Record<string, unknown> = {};
  for (const f of def.fields as { code: string; type: string; required?: boolean; options?: { value: string }[] }[]) {
    if (f.required) data[f.code] = f.type === 'number' ? 1 : f.type === 'date' ? '2026-11-27' : f.type === 'yes_no' ? true : (f.type === 'list' && f.options?.length ? f.options[0].value : 'WALK-MEDIA');
  }
  const made = await page.request.post('/api/v1/registers/financial_advances/records', { headers: csrf, data: { site_id: '07148b4b-33e3-48d6-8f32-5c3161dd074a', data, record_type: 'advance' } });
  expect(made.status(), await made.text()).toBe(201);
  const rec = await made.json();

  const slots = await (await page.request.get(`/api/v1/registers/financial_advances/records/${rec.id}/slots`)).json();
  const slotId = (slots.items as { id: string; doc_code?: string; type?: { code?: string } }[]).find((s) => (s.doc_code ?? s.type?.code) === 'ADV_PROOF')?.id
    ?? (slots.items as { id: string }[])[0]!.id;

  const up = await page.request.post(`/api/v1/registers/financial_advances/records/${rec.id}/slots/${slotId}/files`, {
    headers: csrf,
    multipart: { file: { name: 'walk-proof.png', mimeType: 'image/png', buffer: PNG } },
  });
  expect(up.status(), await up.text()).toBe(201);

  // The API already lists it.
  const items = await (await page.request.get('/api/v1/media/items')).json();
  console.log('media items:', JSON.stringify(items).slice(0, 400));
  const mine = (items.items as { id: string; name: string; uploaded_at: string }[])
    .filter((i) => i.name === 'walk-proof.png')
    .sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at))[0]!;

  // EN: the gallery grid shows the card with its type, record link and download.
  await page.goto('/library/media');
  await expect(page.getByTestId('page-library-media')).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId('media-grid')).toBeVisible();
  const card = page.getByTestId(`media-card-${mine.id}`);
  await expect(card).toBeVisible();
  // the thumbnail arrives async; give it a moment, then record what rendered (img vs type icon)
  await page.waitForTimeout(2500);
  const thumbCount = await page.getByTestId('media-thumb').count();
  const thumbVisible = thumbCount > 0 && (await page.getByTestId('media-thumb').first().isVisible());
  console.log('thumbnail rendered:', thumbVisible, '| count:', thumbCount);
  await expect(card.getByTestId('media-open')).toBeVisible();
  await expect(card.getByTestId('media-download')).toBeVisible();
  await page.screenshot({ path: 'test-results/walk364-media-list-en.png' });

  // Filters reach the list: source=documents keeps the card; a nonsense search empties it.
  await page.getByTestId('media-f-source').selectOption('documents');
  await expect(card).toBeVisible();
  await page.getByTestId('media-search').fill('no-such-thing-zzz');
  await expect(page.getByTestId('media-empty')).toBeVisible({ timeout: 10000 });
  await page.getByTestId('media-search').fill('');
  await expect(card).toBeVisible();

  // Date filters (finding 2): the shared DateInput is used and filters the list.
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const tomorrow = iso(new Date(Date.now() + 86400000));
  await page.getByTestId('media-f-from').fill(tomorrow);
  await expect(page.getByTestId('media-empty')).toBeVisible({ timeout: 10000 });
  await page.screenshot({ path: 'test-results/walk364-media-datefilter-en.png' });
  await page.getByTestId('media-f-from').fill('2020-01-01');
  await page.getByTestId('media-f-to').fill(tomorrow);
  await expect(card).toBeVisible({ timeout: 10000 });
  await page.getByTestId('media-f-from').fill('');
  await page.getByTestId('media-f-to').fill('');
  await expect(card).toBeVisible();

  // Open record (finding 1): the card link lands on the register page; record the landing state (the id-space question is under review).
  await card.getByTestId('media-open').click();
  await page.waitForTimeout(1200);
  console.log('media-open landed on:', page.url());
  console.log('drawer opened:', await page.getByTestId('register-drawer-body').isVisible().catch(() => false));
  console.log('not-found dialog:', await page.getByText('This record or register was not found.').isVisible().catch(() => false));
  await page.screenshot({ path: 'test-results/walk364-media-openrecord-en.png' });

  // The record's Documents tab shows the uploaded file (the upload door), opening the record by its row id.
  await page.goto(`/registers/financial_advances?record=${rec.id}`);
  await expect(page.getByTestId('register-drawer-body')).toBeVisible({ timeout: 20000 });
  await page.screenshot({ path: 'test-results/walk364-media-openrecord-en.png' });
  await page.getByRole('tab', { name: /Documents|المستندات/ }).click();
  await expect(page.locator('text="walk-proof.png" >> visible=true').first()).toBeVisible({ timeout: 10000 });
  await page.screenshot({ path: 'test-results/walk364-media-upload-en.png' });
  await page.keyboard.press('Escape');

  // Settings > Documents > Media: every key of media.gallery (read-only pass + screenshot; the audited save is unit-tested in the PR).
  await page.goto('/admin/settings/documents/media');
  await page.screenshot({ path: 'test-results/walk364-media-settings-en.png' });

  // AR: mirrored layout, no horizontal overflow, geometry sane.
  await page.getByTestId('topbar-lang').click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await page.screenshot({ path: 'test-results/walk364-media-settings-ar.png' });
  await page.goto('/library/media');
  await expect(page.getByTestId('media-grid')).toBeVisible({ timeout: 20000 });
  const overflow = await page.evaluate(() => document.scrollingElement!.scrollWidth - window.innerWidth);
  console.log('horizontal overflow px:', overflow);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: 'test-results/walk364-media-list-ar.png' });

  // Back to English for the next walk.
  await page.getByTestId('topbar-lang').click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
});

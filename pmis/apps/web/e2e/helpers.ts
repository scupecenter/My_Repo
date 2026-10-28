import { expect, type Page } from '@playwright/test';

/** Synthetic demo accounts of the mock layer (README). Never real secrets. */
export const DEMO = {
  pm: { id: '1001', password: 'Demo-Pm-2026-pass' },
  /** Sami Nuri (1204): has one unanswered announcement in the seed, so the blocking pop-up shows right after sign-in. */
  engineer: { id: '1204', password: 'Demo-Staff-2026-pass' },
  reviewer: { id: '1102', password: 'Demo-Lead-2026-pass' },
  auditor: { id: '1103', password: 'Demo-Audit-2026-pass' },
  pending: { id: '1211', password: 'Demo-Pending-2026-pass' },
  newbie: { id: 'new.employee@example.com', password: 'Demo-First-2026-pass' },
} as const;
export type DemoAccount = keyof typeof DEMO;

/** Local sign-in through the one box. */
export async function login(page: Page, account: DemoAccount) {
  await page.goto('/login');
  await page.getByTestId('login-identifier').fill(DEMO[account].id);
  await page.getByTestId('login-password').fill(DEMO[account].password);
  await page.getByTestId('login-submit').click();
}

/** Answers the step-up dialog of a local session with the account's password. */
export async function stepUp(page: Page, account: DemoAccount = 'pm') {
  await expect(page.getByTestId('stepup-dialog')).toBeVisible();
  await page.getByTestId('stepup-password').fill(DEMO[account].password);
  await page.getByTestId('stepup-continue').click();
  await expect(page.getByTestId('stepup-dialog')).toHaveCount(0);
}

/** Runs `act` (which triggers a step-up), then answers the dialog. */
export async function withStepUp(page: Page, act: () => Promise<void>, account: DemoAccount = 'pm') {
  await act();
  await stepUp(page, account);
}

/**
 * Answers the blocking announcement pop-up while one is showing (the seed gives the engineer account one, ADR 0013).
 * `agree` answers every pop-up with Agree; `disagree` with Disagree and the note. Returns how many were answered.
 */
export async function answerAnnouncements(page: Page, decision: 'agree' | 'disagree' = 'agree', note = 'Cannot comply with this') {
  let n = 0;
  for (;;) {
    const popup = page.getByTestId('ann-popup');
    try { await popup.waitFor({ state: 'visible', timeout: n === 0 ? 5_000 : 1_500 }); } catch { return n; }
    const title = await page.getByTestId('ann-popup-title').textContent();
    if (decision === 'agree') await page.getByTestId('ann-popup-agree').click();
    else { await page.getByTestId('ann-popup-disagree').click(); await page.getByTestId('ann-popup-note').fill(note); await page.getByTestId('ann-popup-submit').click(); }
    await expect(page.getByTestId('ann-popup-title').filter({ hasText: title ?? '' })).toHaveCount(0);
    n += 1;
  }
}

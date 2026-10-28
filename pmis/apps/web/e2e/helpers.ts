import { expect, type Page } from '@playwright/test';

/** Synthetic demo accounts of the mock layer (README). Never real secrets. */
export const DEMO = {
  pm: { id: '1001', password: 'Demo-Pm-2026-pass' },
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

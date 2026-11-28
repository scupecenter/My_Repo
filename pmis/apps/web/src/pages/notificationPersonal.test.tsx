import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '@/App';
import { renderApp, signIn } from '@/test/utils';

// Item 4 / item 7 (contract 0.15.531): Profile > Notifications, EN and AR, against the mock door.
describe('Profile > Notifications (personal layer)', () => {
  for (const locale of ['en', 'ar'] as const) {
    it(`turns a type off, sets do-not-disturb, snoozes and sends a test (${locale})`, async () => {
      await signIn('pm');
      renderApp(<App />, { route: '/profile', locale });
      const user = userEvent.setup();
      const sec = await screen.findByTestId('profile-notifications');
      expect(sec).toBeTruthy();
      // a mandatory type is on and cannot be changed
      const sec1 = await screen.findByTestId('npp-ch-security_alert-email');
      expect((sec1 as HTMLInputElement).checked).toBe(true);
      expect((sec1 as HTMLInputElement).disabled).toBe(true);
      // turn one type's e-mail off, switch the schedule on, save
      const ch = locale === 'en' ? 'email' : 'in_app'; // the mock keeps its state between the two runs, so each run changes another box
      await user.click(await screen.findByTestId(`npp-ch-task_assigned-${ch}`));
      await user.click(screen.getByTestId('npp-dnd-enabled'));
      await user.click(screen.getByTestId('npp-save'));
      await waitFor(() => expect((screen.getByTestId(`npp-ch-task_assigned-${ch}`) as HTMLInputElement).checked).toBe(false));
      expect((screen.getByTestId('npp-dnd-enabled') as HTMLInputElement).checked).toBe(locale === 'en');
      expect((screen.getByTestId('npp-save') as HTMLButtonElement).disabled).toBe(true);
      // snooze puts the person in quiet time, clear ends it
      await user.click(screen.getByTestId('npp-snooze-1'));
      await waitFor(() => expect(screen.getByTestId('npp-quiet-state').textContent).toMatch(locale === 'en' ? /Quiet now/ : /وقت هدوء الآن/));
      await user.click(screen.getByTestId('npp-snooze-clear'));
      await waitFor(() => expect(screen.getByTestId('npp-quiet-state').textContent).toMatch(locale === 'en' ? /Not in quiet time/ : /ليس وقت هدوء/));
      // the test notice
      await user.click(screen.getByTestId('npp-test'));
      await waitFor(() => expect((screen.getByTestId('npp-test') as HTMLButtonElement).disabled).toBe(false));
      expect(screen.getByTestId('npp-held-none')).toBeTruthy();
    });
  }
});

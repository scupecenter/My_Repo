import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '@/App';
import ar from '@/i18n/ar.json';
import en from '@/i18n/en.json';
import { WHATS_NEW } from '@/content/whatsNew';
import { renderApp, signIn } from '@/test/utils';

beforeEach(() => localStorage.clear());

describe("What's new and the short guide", () => {
  it('every note and guide section has both languages', () => {
    for (const d of [en, ar] as any[]) {
      for (const e of WHATS_NEW) { expect(d.whatsNewItems[e.id].title).toBeTruthy(); expect(d.whatsNewItems[e.id].text).toBeTruthy(); }
      for (const s of ['start', 'work', 'registers', 'templates', 'alerts', 'settings', 'help']) expect(d.guide[s].text).toBeTruthy();
    }
  });

  it('shows a dot on the menu until the notes are opened, and opens the guide', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<App />, { route: '/' });
    await u.click(await screen.findByTestId('topbar-user'));
    expect(await screen.findByTestId('whats-new-dot')).toBeInTheDocument();
    await u.click(screen.getByTestId('user-menu-whats-new'));
    expect(await screen.findByTestId('page-whats-new')).toBeInTheDocument();
    expect(screen.getByTestId(`whats-new-${WHATS_NEW[0]!.id}`)).toBeInTheDocument();
    await u.click(screen.getByTestId('topbar-user'));
    expect(screen.queryByTestId('whats-new-dot')).toBeNull();
    await u.click(screen.getByTestId('user-menu-guide'));
    expect(await screen.findByTestId('page-guide')).toBeInTheDocument();
    expect(screen.getByTestId('guide-settings')).toBeInTheDocument();
  });
});

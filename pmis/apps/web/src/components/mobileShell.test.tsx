import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AppBanner, bannerKey } from '@/components/AppBanner';
import { MobileBar } from '@/components/MobileBar';
import { NAV } from '@/components/navItems';
import { renderApp, signIn } from '@/test/utils';

const items = NAV.filter((n) => ['my_work', 'inbox', 'approvals'].includes(n.key));

describe('Mobile bar', () => {
  it('links the main places this person may see and opens the menu from More', async () => {
    await signIn('pm');
    let more = 0;
    renderApp(<MobileBar items={items} unread={3} onMore={() => { more += 1; }} />);
    expect(await screen.findByTestId('mobile-bar-my_work')).toHaveAttribute('href', '/my-work');
    expect(screen.getByTestId('mobile-bar-inbox')).toBeInTheDocument();
    expect(screen.queryByTestId('mobile-bar-dashboard')).toBeNull();
    expect(screen.getByTestId('mobile-bar-unread')).toHaveTextContent('3');
    await userEvent.setup().click(screen.getByTestId('mobile-bar-more'));
    expect(more).toBe(1);
  });
});

describe('App banner', () => {
  it('shows, is dismissed once and stays dismissed; off by the setting', async () => {
    localStorage.removeItem(bannerKey('u-banner'));
    const { unmount } = renderApp(<AppBanner userId="u-banner" enabled />);
    expect(await screen.findByTestId('app-banner')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByTestId('app-banner-dismiss'));
    expect(screen.queryByTestId('app-banner')).toBeNull();
    unmount();
    renderApp(<AppBanner userId="u-banner" enabled />);
    expect(screen.queryByTestId('app-banner')).toBeNull();
    localStorage.removeItem(bannerKey('u-banner'));
    unmount();
    renderApp(<AppBanner userId="u-banner" enabled={false} />);
    expect(screen.queryByTestId('app-banner')).toBeNull();
  });
});

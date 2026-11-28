import '@/i18n';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { setExtra } from '@/lib/uiExtras';
import { ageText, LastUpdated, pageDataStamp } from './LastUpdated';

/** Item 3: "Updated X min ago" + refresh. */
afterEach(() => { act(() => setExtra('last_updated', true)); });

describe('ageText', () => {
  it('says just now under 45 s, then minutes, hours and days, in the language', () => {
    expect(ageText(10_000, 'en', 'just now')).toBe('just now');
    expect(ageText(3 * 60_000, 'en', 'x')).toMatch(/3.*min/);
    expect(ageText(2 * 3600_000, 'en', 'x')).toMatch(/2.*hr/);
    expect(ageText(3 * 86400_000, 'en', 'x')).toMatch(/3.*day/);
    expect(ageText(3 * 60_000, 'ar', 'x')).toMatch(/٣|3/);
    expect(ageText(-5, 'en', 'now')).toBe('now');
  });
});

let hits = 0;
function Page() {
  useQuery({ queryKey: ['dashboard', 'x'], queryFn: async () => ++hits });
  useQuery({ queryKey: ['me'], queryFn: async () => 'me' });
  return <LastUpdated />;
}

describe('LastUpdated', () => {
  it('ignores background queries when it dates the page, shows the note and refetches on the button', async () => {
    const qc = new QueryClient();
    const u = userEvent.setup();
    render(<QueryClientProvider client={qc}><Page /></QueryClientProvider>);
    expect(await screen.findByTestId('last-updated-text')).toHaveTextContent(/just now|الآن/i);
    const dash = qc.getQueryCache().find({ queryKey: ['dashboard', 'x'] })!.state.dataUpdatedAt;
    expect(pageDataStamp(qc)).toBe(dash);
    const before = hits;
    await u.click(screen.getByTestId('last-updated-refresh'));
    await waitFor(() => expect(hits).toBe(before + 1));
  });

  it('shows nothing with no page data, and nothing when switched off', async () => {
    const qc = new QueryClient();
    const { container } = render(<QueryClientProvider client={qc}><LastUpdated /></QueryClientProvider>);
    expect(container).toBeEmptyDOMElement();
    const qc2 = new QueryClient();
    render(<QueryClientProvider client={qc2}><Page /></QueryClientProvider>);
    expect(await screen.findAllByTestId('last-updated')).toHaveLength(1);
    act(() => setExtra('last_updated', false));
    expect(screen.queryAllByTestId('last-updated')).toHaveLength(0);
  });
});

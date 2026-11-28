import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { api } from '@/api/client';
import { SitePackButton } from '@/components/ExportDialog';
import { renderApp, signIn } from '@/test/utils';

// D5 (contract 0.15.461): the Site pack button starts a site_pack export; it lands in the export list as kind site_pack.
describe('site pack button', () => {
  it('names itself, starts the export of its site and shows it in the list', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<SitePackButton siteId="11111111-1111-4111-8111-111111111111" testid="site-pack" />);
    const b = screen.getByTestId('site-pack');
    expect(b).toHaveAttribute('aria-label', 'Site pack');
    expect(b).toHaveAttribute('title');
    await u.click(b);
    await waitFor(async () => {
      const list = await api.get<{ items: { kind: string; site_id?: string }[] }>('/exports/master');
      expect(list.items[0]).toMatchObject({ kind: 'site_pack', site_id: '11111111-1111-4111-8111-111111111111' });
    });
  });
});

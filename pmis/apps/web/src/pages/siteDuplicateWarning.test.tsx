import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { renderApp, signIn } from '@/test/utils';
import { NewSite } from './NewSite';

/** Contract 0.15.96: a site named like a waiting draft is saved with a warning, shown after the save and beside the draft. */
const fill = async (u: ReturnType<typeof userEvent.setup>, o: Record<string, string>) => {
  for (const [k, v] of Object.entries(o)) {
    const el = await screen.findByTestId(`ns-${k}`);
    if (el.tagName === 'SELECT') await u.selectOptions(el, v);
    else { await u.clear(el); await u.type(el, v); }
  }
};

describe('New site, duplicate warnings', () => {
  it('warns about the same name, never blocks', async () => {
    await signIn('pm');
    renderApp(<Routes><Route path="/sites/new" element={<NewSite />} /></Routes>, { route: '/sites/new' });
    const u = userEvent.setup();
    await fill(u, { site_code: 'DUPW-1', region_id: '1', name: 'Twin Hill' });
    await u.click(await screen.findByTestId('ns-save'));
    await screen.findByTestId('ns-draft-DUPW-1');
    expect(screen.queryByTestId('ns-saved-warnings')).not.toBeInTheDocument();
    await fill(u, { site_code: 'DUPW-2', region_id: '1', name: 'twin  hill' });
    await u.click(screen.getByTestId('ns-save'));
    const box = await screen.findByTestId('ns-saved-warnings');
    expect(box).toHaveTextContent('DUPW-2');
    expect(box.querySelector('[data-code="duplicate_name"]')).toHaveTextContent('A site with this name exists.');
    expect(await screen.findByTestId('ns-draft-warnings-DUPW-2')).toBeInTheDocument();
  });
});

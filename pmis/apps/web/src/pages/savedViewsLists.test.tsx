import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { renderApp, signIn } from '@/test/utils';
import { Inbox } from './Inbox';
import { Messages } from './Messages';
import { Warehouse } from './Warehouse';
import { LibraryForms } from './library/Forms';

/** Review item 6 (owner decision 35): the saved-views bar (the standard SavedViews) is on the Warehouse lists, the Library forms, the Inbox and Messages. */
const bar = async (screen_: string) => {
  const el = await screen.findByTestId('saved-views');
  expect(el).toHaveAttribute('data-screen', screen_);
  return el;
};

describe('saved-views bar on the remaining lists', () => {
  it('Warehouse: one bar per list tab, with the screen key of the tab', async () => {
    await signIn('pm');
    renderApp(<Routes><Route path="/warehouse" element={<Warehouse />} /></Routes>, { route: '/warehouse' });
    const u = userEvent.setup();
    await bar('warehouse-items');
    for (const [tab, key] of [['movements', 'warehouse-movements'], ['stock', 'warehouse-stock'], ['dispatch', 'warehouse-dispatch']] as const) {
      await u.click(await screen.findByTestId(`wh-tab-${tab}`));
      await waitFor(() => expect(screen.getByTestId('saved-views')).toHaveAttribute('data-screen', key));
    }
  });
  it('Library forms, Inbox and Messages carry the bar', async () => {
    await signIn('pm');
    const a = renderApp(<Routes><Route path="/library/templates" element={<LibraryForms />} /></Routes>, { route: '/library/templates' });
    await bar('library-forms');
    a.unmount();
    const b = renderApp(<Routes><Route path="/inbox" element={<Inbox />} /></Routes>, { route: '/inbox' });
    await bar('inbox');
    b.unmount();
    renderApp(<Routes><Route path="/messages" element={<Messages />} /></Routes>, { route: '/messages' });
    await bar('messages');
  });
});

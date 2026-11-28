import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { API_BASE } from '@/api/client';
import { server } from '@/mocks/server';
import { renderApp, signIn } from '@/test/utils';
import { RecordLinkSelect } from './P4cPanels';

describe('RecordLinkSelect (D60, generic link picker)', () => {
  it('lists the options of a declared link and reports the chosen entity id', async () => {
    await signIn('pm');
    server.use(http.get(`${API_BASE}/registers/invoices/link-options/payment_ref_id`, ({ request }) => {
      expect(new URL(request.url).searchParams.get('site_id')).toBe('s1');
      return HttpResponse.json({ items: [{ entity_id: 'e1', label: 'PO-1 · PR-9' }, { entity_id: 'e2', label: 'PO-2' }] });
    }));
    let v: string | null = null;
    renderApp(<RecordLinkSelect registerKey="invoices" field="payment_ref_id" siteId="s1" value="" onChange={(n) => { v = n; }} editable targetLabel="procurement" />);
    const sel = await screen.findByTestId('reg-field-payment_ref_id');
    await screen.findByText('PO-1 · PR-9');
    await userEvent.selectOptions(sel, 'e2');
    expect(v).toBe('e2');
  });

  it('shows the label of the chosen record when read only', async () => {
    await signIn('pm');
    server.use(http.get(`${API_BASE}/registers/invoices/link-options/x_id`, () => HttpResponse.json({ items: [{ entity_id: 'e1', label: 'PO-1' }] })));
    renderApp(<RecordLinkSelect registerKey="invoices" field="x_id" siteId={null} value="e1" onChange={() => undefined} editable={false} />);
    expect(await screen.findByTestId('reg-view-x_id')).toHaveTextContent('e1'.slice(0, 2));
  });
});

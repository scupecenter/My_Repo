import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { API_BASE } from '@/api/client';
import { server } from '@/mocks/server';
import { renderApp, signIn } from '@/test/utils';
import { SiteLinkedRecords } from './SiteLinkedRecords';

describe('SiteLinkedRecords (D60 phase 3)', () => {
  it('lists the registers with records at the site, their links, and marks a register with no declared link', async () => {
    await signIn('pm');
    server.use(http.get(`${API_BASE}/registers/site-linked/s1`, () => HttpResponse.json({ items: [
      { register_key: 'invoices', name_en: 'Invoices', name_ar: null, count: 2, linked: true, items: [
        { entity_id: 'e1', record_id: 'r1', state: 'entry', title: 'INV-1', links: [{ field: 'procurement_record_id', target_register: 'procurement', entity_id: 'p1', label: 'PO-7' }] },
      ] },
      { register_key: 'procurement', name_en: 'Procurement', name_ar: null, count: 1, linked: true, items: [{ entity_id: 'p1', title: 'PO-7', links: [] }] },
      { register_key: 'meetings', name_en: 'Meetings', name_ar: null, count: 3, linked: false, items: [] },
    ] })));
    renderApp(<SiteLinkedRecords siteId="s1" />);
    expect(await screen.findByTestId('site-linked-invoices')).toHaveTextContent('INV-1');
    expect(screen.getByTestId('site-linked-link')).toHaveTextContent('Procurement: PO-7');
    expect(screen.getByTestId('site-linked-count-invoices')).toHaveTextContent('2');
    expect(screen.getByTestId('site-linked-orphan-meetings')).toBeInTheDocument();
    expect(screen.queryByTestId('site-linked-orphan-invoices')).not.toBeInTheDocument();
  });

  it('says so when the caller may see no register of the site', async () => {
    await signIn('pm');
    server.use(http.get(`${API_BASE}/registers/site-linked/s2`, () => HttpResponse.json({ items: [] })));
    renderApp(<SiteLinkedRecords siteId="s2" />);
    expect(await screen.findByTestId('site-linked-empty')).toBeInTheDocument();
  });
});

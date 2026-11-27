import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { API_BASE } from '@/api/client';
import { server } from '@/mocks/server';
import { renderApp, signIn } from '@/test/utils';
import { SettingsRoutes } from './settings/Settings';

/** Item 12 (contract 0.15.104): Settings > Documents > Search index, read only counts for a System Admin. */
const counts = { indexed: 12, empty: 1, unsupported: 3, too_large: 0, failed: 2, pending: 4, last_extracted_at: '2026-11-27T01:00:00Z' };
const open = (locale: 'en' | 'ar' = 'en') =>
  renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/documents/search', locale });

describe('Settings > Documents > Search index', () => {
  it('shows the counts and the note about how files are read', async () => {
    server.use(http.get(`${API_BASE}/admin/document-search-index`, () => HttpResponse.json(counts)));
    await signIn('pm');
    open();
    expect(await screen.findByTestId('settings-document-search-index')).toBeInTheDocument();
    expect(screen.getByTestId('dsi-indexed')).toHaveTextContent('12');
    expect(screen.getByTestId('dsi-pending')).toHaveTextContent('4');
    expect(screen.getByTestId('dsi-failed')).toHaveTextContent('2');
    expect(screen.getByText(/virus scan/)).toBeInTheDocument();
  });

  it('renders in Arabic', async () => {
    server.use(http.get(`${API_BASE}/admin/document-search-index`, () => HttpResponse.json(counts)));
    await signIn('pm');
    open('ar');
    expect(await screen.findByText('فهرس البحث في المستندات')).toBeInTheDocument();
  });
});

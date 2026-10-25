import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import '@/i18n';
import { applyLocale } from '@/i18n';
import { StepUpProvider } from '@/components/StepUp';
import { ToastProvider } from '@/components/Toast';
import { api, setCsrfToken } from '@/api/client';

export async function signIn(account: 'pm' | 'reviewer' | 'newbie' | 'pending' = 'pm') {
  await api.post('/__mock/signin', { body: { account } });
  const s = await api.get<{ csrf_token: string }>('/auth/session');
  setCsrfToken(s.csrf_token);
}

export function renderApp(ui: ReactElement, { route = '/', locale = 'en' as 'en' | 'ar' } = {}) {
  applyLocale(locale);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { qc, ...render(
    <QueryClientProvider client={qc}><MemoryRouter initialEntries={[route]}><ToastProvider><StepUpProvider>{ui}</StepUpProvider></ToastProvider></MemoryRouter></QueryClientProvider>,
  ) };
}

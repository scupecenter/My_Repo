import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import '@/i18n';
import { applyLocale } from '@/i18n';
import { StepUpProvider } from '@/components/StepUp';
import { UnsavedGuardProvider } from '@/lib/unsavedGuard';
import { ToastProvider } from '@/components/Toast';
import { api, setCsrfToken } from '@/api/client';

export async function signIn(account: 'pm' | 'engineer' | 'reviewer' | 'auditor' | 'newbie' | 'pending' = 'pm') {
  await api.post('/__mock/signin', { body: { account } });
  const s = await api.get<{ csrf_token: string }>('/auth/session');
  setCsrfToken(s.csrf_token);
}

export function renderApp(ui: ReactElement, { route = '/', locale = 'en' as 'en' | 'ar' } = {}) {
  applyLocale(locale);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { qc, ...render(
    <QueryClientProvider client={qc}><MemoryRouter initialEntries={[route]} useTransitions={false}><ToastProvider><StepUpProvider><UnsavedGuardProvider>{ui}</UnsavedGuardProvider></StepUpProvider></ToastProvider></MemoryRouter></QueryClientProvider>,
  ) };
}

/** Opens the unified filter ("+ Filter") and picks one field of its dropdown (the field key, or the key of a page extra such as `late`). */
export async function pickFilterField(u: UserEvent, key: string) {
  await u.click(await screen.findByTestId('filter-add')); // rendered once the field catalog has loaded
  await u.click(await screen.findByTestId(`filter-field-${key}`));
}

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { StepUpProvider } from './components/StepUp';
import { ToastProvider } from './components/Toast';
import { applyLocale, applyTheme, currentLocale, currentTheme } from './i18n';
import { applyBrand, savedBrand } from './lib/brands';
import './styles/index.css';

applyLocale(currentLocale());
applyTheme(currentTheme());
applyBrand(savedBrand());

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });

async function boot() {
  // Swap mocks for the real API with VITE_USE_MOCKS=false (see README).
  if (import.meta.env.VITE_USE_MOCKS === 'true') {
    const { worker } = await import('./mocks/browser');
    await worker.start({ onUnhandledFrame: 'bypass', quiet: true });
    // Hybrid (VITE_REAL_API=auth-users): every API route goes to the real server or answers 501 not_available (mocks/realApi.ts); no demo
    // session is created for the real user any more (P0 of the 2026-11-17 audit).
  }
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        {/* react-router 7 navigates inside React.startTransition by default; false keeps the v6 behavior (the screens render each navigation at once) */}
        <BrowserRouter useTransitions={false}>
          <ToastProvider>
            <StepUpProvider>
              <App />
            </StepUpProvider>
          </ToastProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </React.StrictMode>,
  );
}
void boot();

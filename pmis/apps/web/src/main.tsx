import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { StepUpProvider } from './components/StepUp';
import { ToastProvider } from './components/Toast';
import { applyLocale, applyTheme, currentLocale, currentTheme } from './i18n';
import './styles/index.css';

applyLocale(currentLocale());
applyTheme(currentTheme());

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });

async function boot() {
  // Swap mocks for the real API with VITE_USE_MOCKS=false (see README).
  if (import.meta.env.VITE_USE_MOCKS === 'true') {
    const { worker } = await import('./mocks/browser');
    await worker.start({ onUnhandledFrame: 'bypass', quiet: true });
  }
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
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

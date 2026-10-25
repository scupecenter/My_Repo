import { setupWorker } from 'msw/browser';
import { handlers } from './handlers';
import { siteHandlers } from './handlers.sites';
export const worker = setupWorker(...handlers, ...siteHandlers);

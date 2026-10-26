import { setupWorker } from 'msw/browser';
import { handlers } from './handlers';
import { adminHandlers } from './handlers.admin';
import { settingsHandlers } from './handlers.settings';
import { siteHandlers } from './handlers.sites';
export const worker = setupWorker(...settingsHandlers, ...handlers, ...siteHandlers, ...adminHandlers);

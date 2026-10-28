import { setupWorker } from 'msw/browser';
import { handlers } from './handlers';
import { adminHandlers } from './handlers.admin';
import { authHandlers } from './handlers.auth';
import { settingsHandlers } from './handlers.settings';
import { siteHandlers } from './handlers.sites';
import { orgHandlers } from './handlers.org';
import { realApiHandlers } from './realApi';
// Hybrid mode: the real-API passthroughs come first, so they win over the mock of the same method + path.
export const worker = setupWorker(...realApiHandlers(), ...authHandlers, ...settingsHandlers, ...handlers, ...siteHandlers, ...adminHandlers, ...orgHandlers);

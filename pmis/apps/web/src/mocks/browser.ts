import { setupWorker } from 'msw/browser';
import { handlers } from './handlers';
import { documentHandlers } from './handlers.documents';
import { adminHandlers } from './handlers.admin';
import { authHandlers } from './handlers.auth';
import { profileHandlers } from './handlers.profile';
import { dashboardHandlers } from './handlers.dashboard';
import { settingsHandlers } from './handlers.settings';
import { siteHandlers } from './handlers.sites';
import { registerHandlers } from './handlers.registers';
import { warehouseHandlers } from './handlers.warehouse';
import { xHandlers } from './handlers.x';
import { orgHandlers } from './handlers.org';
import { realApiHandlers } from './realApi';
// Hybrid mode: the real-API passthroughs come first, so they win over the mock of the same method + path.
export const worker = setupWorker(...realApiHandlers(), ...xHandlers, ...registerHandlers, ...warehouseHandlers, ...authHandlers, ...profileHandlers, ...documentHandlers, ...settingsHandlers, ...handlers, ...siteHandlers, ...adminHandlers, ...orgHandlers, ...dashboardHandlers);

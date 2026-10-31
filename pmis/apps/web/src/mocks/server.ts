import { setupServer } from 'msw/node';
import { handlers } from './handlers';
import { adminHandlers } from './handlers.admin';
import { authHandlers } from './handlers.auth';
import { orgHandlers } from './handlers.org';
import { settingsHandlers } from './handlers.settings';
import { siteHandlers } from './handlers.sites';
import { registerHandlers } from './handlers.registers';
export const server = setupServer(...registerHandlers, ...authHandlers, ...settingsHandlers, ...handlers, ...siteHandlers, ...adminHandlers, ...orgHandlers);

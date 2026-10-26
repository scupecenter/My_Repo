import { setupServer } from 'msw/node';
import { handlers } from './handlers';
import { adminHandlers } from './handlers.admin';
import { settingsHandlers } from './handlers.settings';
import { siteHandlers } from './handlers.sites';
export const server = setupServer(...settingsHandlers, ...handlers, ...siteHandlers, ...adminHandlers);

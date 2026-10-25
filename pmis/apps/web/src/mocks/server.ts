import { setupServer } from 'msw/node';
import { handlers } from './handlers';
import { siteHandlers } from './handlers.sites';
export const server = setupServer(...handlers, ...siteHandlers);

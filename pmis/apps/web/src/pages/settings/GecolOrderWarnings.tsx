import { RegisterOrderWarnings } from './RegisterOrderWarnings';

/**
 * The old GECOL tab (contract 0.12.11, Q151). Since 0.15.464 (M1) it is the generic order warnings panel fixed to the GECOL register. The tab is hidden from the
 * Settings menu (Settings > Registers > Order warnings has every register) and the route stays, so an old link still works.
 */
export function GecolOrderWarnings() {
  return <RegisterOrderWarnings fixed="gecol" />;
}

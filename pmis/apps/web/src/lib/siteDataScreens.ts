/**
 * W8 item 4 of plan 2026-11-23-next-ui-cleanup: every screen that shows site data, with the state of its table standard (the shared toolbar
 * of TableStandard.tsx: saved views, search with the pasted list, + Filter, the server count, the view switcher where it applies, columns,
 * density, Display, Export and the # column). The guard test (tableStandard.test.tsx) renders every `done` screen and fails when one renders
 * without the toolbar or the count. Screens without site data (audit, system and security logs, Users & Roles, Settings tables) are out of scope.
 */
export type ScreenState = 'done' | 'not_applicable';
export interface SiteDataScreen {
  id: string;
  /** the route, as a user opens it */
  route: string;
  state: ScreenState;
  /** `grid`: a table with columns (column chooser and density); `list`: a master-detail list (Approvals) */
  kind?: 'grid' | 'list';
  note: string;
}

export const SITE_DATA_SCREENS: SiteDataScreen[] = [
  { id: 'site-master', route: '/sites', state: 'done', kind: 'grid', note: 'Site Master main list (pipeline, locks, gaps); counts and the pasted list from GET /sites.' },
  { id: 'site-master-stream', route: '/sites?stream=CW', state: 'done', kind: 'grid', note: 'A stream of Site Master (N/A sites join both numbers when shown).' },
  { id: 'site-master-view', route: '/sites?view=CW', state: 'done', kind: 'grid', note: 'A work view of Site Master.' },
  { id: 'site-master-menu', route: '/sites?section=cw', state: 'done', kind: 'grid', note: 'Every Site Master sub-menu (Design & Acquisition, SOW, CW, TE, HOTO, O&M) as a grouped list; rows and counts from GET /site360/{menu}/rows.' },
  { id: 'site-master-wide', route: '/sites?section=master&layout=wide', state: 'done', kind: 'grid', note: 'The wide table of Site Master and of every sub-menu (three header rows).' },
  { id: 'site-master-map', route: '/sites?layout=map', state: 'done', kind: 'grid', note: 'Map layout: the same toolbar; the count comes from a one-row GET /sites with the same filters.' },
  { id: 'site-master-board', route: '/sites?layout=board', state: 'done', kind: 'grid', note: 'Board layout: the same toolbar and count.' },
  { id: 'site-tasks', route: '/sites/:id', state: 'done', kind: 'grid', note: 'The site Tasks table, list layout (default).' },
  { id: 'site-tasks-timeline', route: '/sites/:id (Timeline)', state: 'done', kind: 'list', note: 'The Timeline layout of the site Tasks table: the same toolbar (no column chooser: its columns are the tasks).' },
  { id: 'registers', route: '/registers/:key', state: 'done', kind: 'grid', note: 'Every register and log of Registers & Logs (one shared screen, Register.tsx); counts and the pasted list from GET /registers/{key}/records; noun "issues" on the Issue Log.' },
  { id: 'my-work', route: '/my-work', state: 'done', kind: 'grid', note: 'My Work list (the three buckets as groups); counts, search and the filter tree from GET /me/tasks; Export current view as CSV in the browser.' },
  { id: 'approvals', route: '/approvals', state: 'done', kind: 'list', note: 'Approvals inbox (master-detail list: no column chooser); counts, search and the filter tree from GET /approvals; Export current view as CSV in the browser.' },
  { id: 'dashboard-drilldowns', route: '/sites?dashboard_status=...', state: 'done', kind: 'grid', note: 'Dashboard drill-downs open Site Master with their filter (dashboard_status, milestone_reached, cluster): the Site Master toolbar and counts.' },
  { id: 'daily-plan', route: '/my-work/daily-plan', state: 'not_applicable', note: 'Not built yet (W7). It must use TableToolbar from the start.' },
  { id: 'library-archive', route: '/library/archive/:docCode', state: 'done', kind: 'grid', note: 'Library > Archive, the list of one document type (W5): saved views, search with the pasted list, + Filter (screen library-archive), server counts (GET /library/archive/rows), columns, density, Display, Export current view (every page, CSV), bulk zip, the # column.' },
  { id: 'site-master-grid', route: '/sites?section=cw&layout=grid', state: 'not_applicable', note: 'The hidden Excel-like grid (no button since 2026-11-22, kept for its source panel): its own header, totals row and counts.' },
];

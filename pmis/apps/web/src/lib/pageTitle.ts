/**
 * Browser tab title: "<page or record> | <product>". Pure helpers; the component that applies it is PageTitle.
 * A route maps to an existing menu label key (so EN and AR come from the menu text), a record or site adds its code.
 */
export const PRODUCT_KEY = 'title.product';

/** Longest prefix first. Each entry: path prefix (or exact path for '/') and the i18n key of the page label. */
const ROUTES: [string, string][] = [
  ['/my-work/daily-plan', 'nav.daily_plan'],
  ['/my-work', 'nav.my_work'],
  ['/approvals', 'nav.approvals'],
  ['/inbox', 'nav.inbox'],
  ['/workload', 'nav.workload'],
  ['/reports/contractors', 'nav.contractor_reports'],
  ['/status-updates', 'nav.status_updates'],
  ['/dashboard', 'nav.dashboard'],
  ['/sites/new', 'sites.new_site'],
  ['/sites', 'nav.sites'],
  ['/warehouse', 'nav.warehouse'],
  ['/as-built', 'nav.as_built'],
  ['/data-hub', 'nav.data_hub'],
  ['/finance-hub', 'nav.finance_hub'],
  ['/custom-registers', 'nav.registers.custom'],
  ['/templates/master-import', 'nav.master_import'],
  ['/templates', 'nav.templates'],
  ['/library/forms', 'nav.library.forms'],
  ['/library/archive', 'nav.library.archive'],
  ['/absence', 'nav.absence'],
  ['/messages', 'nav.messages'],
  ['/profile', 'top.my_profile'],
  ['/admin/announcements', 'nav.announcements'],
  ['/admin/users', 'nav.admin.users'],
  ['/admin/online', 'nav.admin.online'],
  ['/admin/assignments', 'nav.admin.assignments'],
  ['/admin/roles', 'nav.admin.roles'],
  ['/admin/profiles', 'nav.admin.profiles'],
  ['/admin/groups', 'nav.admin.groups'],
  ['/admin/delegation', 'nav.admin.delegation'],
  ['/admin/matrix', 'nav.admin.matrix'],
  ['/admin/settings', 'nav.admin.settings'],
  ['/settings', 'nav.admin.settings'],
  ['/admin/security-log', 'nav.admin.security_log'],
  ['/audit', 'nav.audit'],
  ['/admin/logs/field-changes', 'nav.logs.field_changes'],
  ['/admin/logs/online', 'nav.logs.online'],
  ['/admin/logs/alerts', 'nav.logs.alerts'],
  ['/admin/logs/job-runs', 'nav.logs.job_runs'],
  ['/admin/logs/deployments', 'nav.logs.deployments'],
  ['/admin/logs/activity-report', 'nav.logs.activity_report'],
  ['/admin/logs/mail', 'nav.logs.mail'],
  ['/admin/logs/system', 'nav.logs.system'],
  ['/admin/logs/integrity', 'nav.logs.integrity'],
];

export function pageLabelKey(pathname: string): string | null {
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  for (const [prefix, key] of ROUTES) if (p === prefix || p.startsWith(`${prefix}/`)) return key;
  return null;
}

export interface TitleRoute { kind: 'register' | 'record' | 'site' | 'none'; key?: string; id?: string }

/** A register list, a record (page or ?record= drawer) or a site page; everything else is a plain route. */
export function titleRoute(pathname: string, search: string): TitleRoute {
  const rec = /^\/registers\/([^/]+)\/records\/([^/]+)\/?$/.exec(pathname);
  if (rec) return { kind: 'record', key: decodeURIComponent(rec[1]!), id: decodeURIComponent(rec[2]!) };
  const reg = /^\/registers\/([^/]+)\/?$/.exec(pathname);
  if (reg) {
    const id = new URLSearchParams(search).get('record');
    return id ? { kind: 'record', key: decodeURIComponent(reg[1]!), id } : { kind: 'register', key: decodeURIComponent(reg[1]!) };
  }
  const site = /^\/sites\/([^/]+)\/?$/.exec(pathname);
  if (site && site[1] !== 'new') return { kind: 'site', id: decodeURIComponent(site[1]!) };
  return { kind: 'none' };
}

/** "<head> | <product>"; just the product when there is no head. */
export function composeTitle(head: string | null | undefined, product: string): string {
  const h = (head ?? '').replace(/\s+/g, ' ').trim();
  return h ? `${h} | ${product}` : product;
}

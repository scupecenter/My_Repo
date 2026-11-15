import { useTranslation } from 'react-i18next';
import { NavLink, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { Calendar } from './Calendar';
import { DocumentLibrary } from './DocumentLibrary';
import { Notifications } from './Notifications';
import { Retention } from './Retention';
import { Dlp, Freeze, Idle } from './Rules';
import { SlaRules } from './SlaRules';
import { WeightSets } from './WeightSets';
import { StaffVisibility } from './StaffVisibility';
import { TeamScopeMatch } from './TeamScopeMatch';
import { GecolOrderWarnings } from './GecolOrderWarnings';
import { MailKinds } from './MailKinds';
import { useMe } from '@/api/hooks';
import { ContractorRules } from './ContractorRules';
import { Lists } from './Lists';
import { RegisterColumns } from './RegisterColumns';
import { HistoricalWaiver } from './HistoricalWaiver';
import { Imports } from './Imports';
import { Workflow } from './Workflow';
import { Site360 } from './Site360';

export interface SettingsSection { key: string; adminOnly?: boolean }
export interface SettingsTab { key: string; sections: SettingsSection[] }

/** The 11 tabs of Administration > Settings (F19). Tabs with sections show a sub-navigation inside the tab. */
export const SETTINGS_TABS: readonly SettingsTab[] = [
  { key: 'calendar', sections: [] },
  { key: 'workflow', sections: [{ key: 'editor' }, { key: 'freeze' }, { key: 'idle' }] },
  { key: 'sla', sections: [{ key: 'rules' }, { key: 'dlp' }] },
  { key: 'weights', sections: [] },
  { key: 'registers', sections: [{ key: 'columns' }, { key: 'contractors' }, { key: 'gecol' }, { key: 'team-scope' }] },
  { key: 'ddl', sections: [] },
  { key: 'site360', sections: [] },
  { key: 'documents', sections: [{ key: 'library' }, { key: 'mail', adminOnly: true }] },
  { key: 'data', sections: [{ key: 'imports' }, { key: 'historical' }] },
  { key: 'alerts', sections: [] },
  { key: 'security', sections: [{ key: 'staff' }, { key: 'retention' }] },
];

/**
 * Old tab routes (before F19) and the new tab and section each one now opens. Old keys that are also new tab keys
 * (calendar, sla, weights, documents, workflow) reach their default section through the tab's index redirect.
 */
export const LEGACY_SETTINGS_PATHS: Readonly<Record<string, string>> = {
  freeze: 'workflow/freeze',
  idle: 'workflow/idle',
  dlp: 'sla/dlp',
  notifications: 'alerts',
  retention: 'security/retention',
  'staff-visibility': 'security/staff',
  'team-scope': 'registers/team-scope',
  lists: 'ddl',
  'contractor-rules': 'registers/contractors',
  'gecol-order': 'registers/gecol',
  'register-columns': 'registers/columns',
  'mail-kinds': 'documents/mail',
  imports: 'data/imports',
  'historical-waiver': 'data/historical',
};

function Layout() {
  const { t } = useTranslation();
  return (
    <div data-testid="page-settings">
      <h1 className="text-2xl font-bold">{t('nav.admin.settings')}</h1>
      <nav className="my-3 flex flex-wrap gap-1" aria-label={t('nav.admin.settings')}>
        {SETTINGS_TABS.map((tab) => <NavLink key={tab.key} to={`/admin/settings/${tab.key}`} data-testid={`settings-tab-${tab.key}`} className={({ isActive }) => `btn ${isActive ? 'btn-accent' : ''}`}>{t(`settings.tab_${tab.key}`)}</NavLink>)}
      </nav>
      <Outlet />
    </div>
  );
}

/** A tab with sections: a small sub-navigation, then the section. System-admin-only sections are hidden from others. */
function TabFrame({ tab }: { tab: string }) {
  const { t } = useTranslation();
  const me = useMe(true);
  const def = SETTINGS_TABS.find((x) => x.key === tab);
  const sections = (def?.sections ?? []).filter((s) => !s.adminOnly || me.data?.is_system_admin);
  return (
    <div>
      <nav className="mb-3 flex flex-wrap gap-1 border-b border-line pb-2" aria-label={t(`settings.tab_${tab}`)}>
        {sections.map((s) => <NavLink key={s.key} to={`/admin/settings/${tab}/${s.key}`} data-testid={`settings-section-${tab}-${s.key}`} className={({ isActive }) => `btn ${isActive ? 'btn-accent' : ''}`}>{t(`settings.section_${tab}_${s.key}`)}</NavLink>)}
      </nav>
      <Outlet />
    </div>
  );
}

/** Keeps the search and hash of an old URL, so `register-columns?register=gecol` still opens that register. */
function LegacyRedirect({ to }: { to: string }) {
  const { search, hash } = useLocation();
  return <Navigate to={{ pathname: `/admin/settings/${to}`, search, hash }} replace />;
}

/** Mounted at `admin/settings/*`. */
export function SettingsRoutes() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Navigate to="calendar" replace />} />
        <Route path="calendar" element={<Calendar />} />
        <Route path="weights" element={<WeightSets />} />
        <Route path="ddl" element={<Lists />} />
        <Route path="alerts" element={<Notifications />} />
        <Route path="site360" element={<Site360 />} />
        <Route path="workflow" element={<TabFrame tab="workflow" />}>
          <Route index element={<Navigate to="editor" replace />} />
          <Route path="editor" element={<Workflow />} />
          <Route path="freeze" element={<Freeze />} />
          <Route path="idle" element={<Idle />} />
        </Route>
        <Route path="sla" element={<TabFrame tab="sla" />}>
          <Route index element={<Navigate to="rules" replace />} />
          <Route path="rules" element={<SlaRules />} />
          <Route path="dlp" element={<Dlp />} />
        </Route>
        <Route path="registers" element={<TabFrame tab="registers" />}>
          <Route index element={<Navigate to="columns" replace />} />
          <Route path="columns" element={<RegisterColumns />} />
          <Route path="contractors" element={<ContractorRules />} />
          <Route path="gecol" element={<GecolOrderWarnings />} />
          <Route path="team-scope" element={<TeamScopeMatch />} />
        </Route>
        <Route path="documents" element={<TabFrame tab="documents" />}>
          <Route index element={<Navigate to="library" replace />} />
          <Route path="library" element={<DocumentLibrary />} />
          <Route path="mail" element={<MailKinds />} />
        </Route>
        <Route path="data" element={<TabFrame tab="data" />}>
          <Route index element={<Navigate to="imports" replace />} />
          <Route path="imports" element={<Imports />} />
          <Route path="historical" element={<HistoricalWaiver />} />
        </Route>
        <Route path="security" element={<TabFrame tab="security" />}>
          <Route index element={<Navigate to="staff" replace />} />
          <Route path="staff" element={<StaffVisibility />} />
          <Route path="retention" element={<Retention />} />
        </Route>
        {Object.entries(LEGACY_SETTINGS_PATHS).map(([old, to]) => <Route key={old} path={old} element={<LegacyRedirect to={to} />} />)}
      </Route>
    </Routes>
  );
}

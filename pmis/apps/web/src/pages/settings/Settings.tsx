import { useTranslation } from 'react-i18next';
import { NavLink, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { Calendar } from './Calendar';
import { PlanRules } from './PlanRules';
import { DocumentLibrary } from './DocumentLibrary';
import { FormTemplates } from './FormTemplates';
import { WebPushSettings } from './WebPushSettings';
import { ArchiveSettings } from './ArchiveSettings';
import { DocumentSearchIndex } from './DocumentSearchIndex';
import { Notifications } from './Notifications';
import { Retention } from './Retention';
import { Dlp, Freeze, Idle } from './Rules';
import { SlaRules } from './SlaRules';
import { IssueTaskMap } from './IssueTaskMap';
import { WeightSets } from './WeightSets';
import { StaffVisibility } from './StaffVisibility';
import { TeamScopeMatch } from './TeamScopeMatch';
import { DeriveRulesScreen } from './DeriveRules';
import { GecolOrderWarnings } from './GecolOrderWarnings';
import { MailKinds } from './MailKinds';
import { MailPolicy } from './MailPolicy';
import { useMe } from '@/api/hooks';
import { NewBadge } from '@/components/NewBadge';
import { ContractorRules } from './ContractorRules';
import { ContractorPerfThresholds } from './ContractorPerfThresholds';
import { RecycleBinScreen } from './RecycleBin';
import { ExportSchedulesScreen } from './ExportSchedules';
import { MatrixCoverageScreen } from './MatrixCoverage';
import { MatrixSimulateScreen } from './MatrixSimulate';
import { GecolHlcCounts } from './GecolHlcCounts';
import { Lists } from './Lists';
import { RegisterColumns } from './RegisterColumns';
import { CustomRegisters } from './CustomRegisters';
import { HistoricalWaiver } from './HistoricalWaiver';
import { SequenceSettings } from './SequenceSettings';
import { DataReset } from './DataReset';
import { StructureByTemplate } from './StructureByTemplate';
import { Imports, TemplateNoticeCard } from './Imports';
import { DuplicateRowsCard } from './DuplicateRows';
import { KanbanWip } from './KanbanWip';
import { NumberSequences } from './NumberSequences';
import { Studio } from './studio/Studio';
import { SiteMasterColumns } from './SiteMasterColumns';
import { DashboardSettings } from './DashboardSettings';
import { GoalsSettings } from './GoalsSettings';
import { Identity } from './Identity';
import { SecurityLocks } from './SecurityLocks';
import { OpsLimits } from './OpsLimits';
import { SupportAccess } from './SupportAccess';
import { NewDeviceCode } from './NewDeviceCode';
import { Passkeys } from './Passkeys';
import { DisplaySettings } from './DisplaySettings';
import { PmSchedulesSettings } from './PmSchedulesSettings';
import { DailyPlanSettings } from './DailyPlanSettings';
import { MotionSettings } from './MotionSettings';
import { AlertRules } from './AlertRules';
import { AlertSettingsPanel } from './AlertSettings';
import { PEOPLE_TABS, peopleTabAllowed } from '@/components/PeopleAdmin';
import { TemplateMappingPanel } from '../TemplateMapping';
import { LoginPageSettings } from './LoginPage';
import { MediaSettingsScreen } from './MediaSettings';
import { DataHubSettings } from './DataHubSettings';
import { MapSettings } from './MapSettings';
import { FinanceHubSettings } from './FinanceHubSettings';
import { InterfaceSettings } from './InterfaceSettings';
import { OpenRecordSettings } from './OpenRecordSettings';

export interface SettingsSection { key: string; adminOnly?: boolean }
export interface SettingsTab { key: string; sections: SettingsSection[] }

/** The tabs of Administration > Settings (F19, and the dashboard tab of F20). Tabs with sections show a sub-navigation inside the tab. */
export const SETTINGS_TABS: readonly SettingsTab[] = [
  // Settings merge (owner approved 2026-11-25): Calendar + SLA rules + Weights all feed the SLA clock
  { key: 'sla', sections: [{ key: 'rules' }, { key: 'calendar' }, { key: 'weights' }, { key: 'planned' }] },
  { key: 'workflow', sections: [{ key: 'editor' }, { key: 'columns' }, { key: 'sequence' }, { key: 'freeze' }, { key: 'idle' }, { key: 'board' }, { key: 'coverage', adminOnly: true }, { key: 'simulate', adminOnly: true }] },
  // Lists (the dropdown catalogues, old ddl tab) now sit next to the register columns that use them
  { key: 'registers', sections: [{ key: 'columns' }, { key: 'custom' }, { key: 'lists' }, { key: 'contractors' }, { key: 'gecol' }, { key: 'derive' }, { key: 'team-scope' }, { key: 'issue-map' }, { key: 'recycle', adminOnly: true }] },
  // W5: the Document Library section is now named Document types (the old documents/library route redirects); Form templates and Archive are new
  { key: 'documents', sections: [{ key: 'types' }, { key: 'forms' }, { key: 'archive' }, { key: 'media' }, { key: 'numbering' }, { key: 'search', adminOnly: true }] },
  { key: 'data', sections: [{ key: 'imports' }, { key: 'mapping' }, { key: 'historical' }, { key: 'counts', adminOnly: true }, { key: 'export' }, { key: 'structure', adminOnly: true }, { key: 'reset', adminOnly: true }] },
  // Notification policy + Mail kinds (admin only): both are what is sent to people
  { key: 'alerts', sections: [{ key: 'policy' }, { key: 'mail', adminOnly: true }, { key: 'rules', adminOnly: true }, { key: 'push', adminOnly: true }] },
  // DLP months is a data-protection rule, so it moved here from SLA
  { key: 'security', sections: [{ key: 'staff' }, { key: 'retention' }, { key: 'dlp' }, { key: 'locks' }, { key: 'limits' }, { key: 'alerts' }, { key: 'support' }, { key: 'newdevice' }, { key: 'passkeys' }] },
  // Screens: what users see by default (Dashboard, Display menu of the tables, My Work Daily Plan). Records (V5) is personal: each user sets their own
  { key: 'screens', sections: [{ key: 'dashboard' }, { key: 'tables' }, { key: 'records' }, { key: 'daily-plan' }, { key: 'goals' }, { key: 'pm-schedules' }, { key: 'motion' }, { key: 'login' }, { key: 'interface' }, { key: 'data-hub' }, { key: 'finance-hub' }, { key: 'map' }] },
  // People and access: Users, Assignments, Roles, Permission profiles, Groups, Delegation and the Responsibility Matrix stay their own screens; Settings lists them so there is one place to start
  { key: 'access', sections: [] },
  { key: 'identity', sections: [] },
];

/**
 * Old tab routes (before F19) and the new tab and section each one now opens. Old keys that are also new tab keys
 * (calendar, sla, weights, documents, workflow) reach their default section through the tab's index redirect.
 */
export const LEGACY_SETTINGS_PATHS: Readonly<Record<string, string>> = {
  freeze: 'workflow/freeze',
  idle: 'workflow/idle',
  dlp: 'security/dlp',
  notifications: 'alerts/policy',
  retention: 'security/retention',
  'staff-visibility': 'security/staff',
  'team-scope': 'registers/team-scope',
  lists: 'registers/lists',
  ddl: 'registers/lists',
  calendar: 'sla/calendar',
  weights: 'sla/weights',
  dashboard: 'screens/dashboard',
  display: 'screens/tables',
  'my-work': 'screens/daily-plan',
  'my-work/daily-plan': 'screens/daily-plan',
  'sla/dlp': 'security/dlp',
  'contractor-rules': 'registers/contractors',
  'gecol-order': 'registers/gecol',
  'register-columns': 'registers/columns',
  'mail-kinds': 'alerts/mail',
  'documents/mail': 'alerts/mail',
  imports: 'data/imports',
  'historical-waiver': 'data/historical',
  // W3 (2026-11-24): the SiteMaster tab is gone; its Master column menus live in Settings > Workflow > Columns, with the same rights.
  site360: 'workflow/columns',
  'site360-columns': 'workflow/columns',
};

function Layout() {
  const { t } = useTranslation();
  return (
    <div data-testid="page-settings">
      <h1 className="text-2xl font-bold">{t('nav.admin.settings')}</h1>
      <nav className="my-3 flex flex-wrap gap-1" aria-label={t('nav.admin.settings')}>
        <NavLink to="/admin/settings/all" data-testid="settings-tab-all" className={({ isActive }) => `btn ${isActive ? 'btn-accent' : ''}`}>{t('settings.tab_all')}</NavLink>
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
        {sections.map((s) => <NavLink key={s.key} to={`/admin/settings/${tab}/${s.key}`} data-testid={`settings-section-${tab}-${s.key}`} className={({ isActive }) => `btn ${isActive ? 'btn-accent' : ''}`}>{t(`settings.section_${tab}_${s.key}`)}{tab === 'screens' && s.key === 'interface' && <NewBadge feature="interface-settings" />}</NavLink>)}
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

/** The first page of Settings (review item 11): every tab with its sections, so nobody has to guess where a setting lives. System-admin-only sections are hidden from others. */
function SettingsIndex() {
  const { t } = useTranslation();
  const me = useMe(true);
  return (
    <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="settings-index">
      {SETTINGS_TABS.map((tab) => {
        const sections = tab.sections.filter((s) => !s.adminOnly || me.data?.is_system_admin);
        return (
          <div key={tab.key} className="card space-y-2 p-4" data-testid={`settings-index-${tab.key}`}>
            <h2 className="font-bold"><NavLink to={`/admin/settings/${tab.key}`} className="hover:underline">{t(`settings.tab_${tab.key}`)}</NavLink></h2>
            <p className="text-xs text-mute">{t(`settings.index_${tab.key}`)}</p>
            {sections.length > 0 && (
              <ul className="flex flex-wrap gap-1">
                {sections.map((s) => <li key={s.key}><NavLink to={`/admin/settings/${tab.key}/${s.key}`} data-testid={`settings-index-${tab.key}-${s.key}`} className="btn px-2 py-1 text-xs">{t(`settings.section_${tab.key}_${s.key}`)}</NavLink></li>)}
              </ul>
            )}
          </div>
        );
      })}
    </section>
  );
}

/** Settings > Access: the People screens (Users, Roles, ...) listed with what each one holds. Each opens only for people who may open it. */
function AccessHub() {
  const { t } = useTranslation();
  const me = useMe(true);
  return (
    <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="settings-access">
      {PEOPLE_TABS.filter((p) => !p.grant).map((p) => {
        const ok = peopleTabAllowed(me.data, p);
        const n = p.key.slice(6);
        return (
          <div key={p.key} className="card space-y-2 p-4" data-testid={`settings-access-${n}`}>
            <h2 className="font-bold">{t(p.key === 'admin.roles' ? 'nav.admin.roles' : p.label)}</h2>
            <p className="text-xs text-mute">{t(`settings.access_${n}`)}</p>
            {ok ? <NavLink to={p.to} data-testid={`settings-access-open-${n}`} className="btn px-2 py-1 text-xs">{t('settings.access_open')}</NavLink> : <p className="text-xs text-mute">{t('settings.access_no')}</p>}
          </div>
        );
      })}
    </section>
  );
}

/** Mounted at `admin/settings/*`. */
export function SettingsRoutes() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Navigate to="sla" replace />} />
        <Route path="all" element={<SettingsIndex />} />
        <Route path="access" element={<AccessHub />} />
        <Route path="identity" element={<Identity />} />
        <Route path="screens" element={<TabFrame tab="screens" />}>
          <Route index element={<Navigate to="dashboard" replace />} />
          <Route path="dashboard" element={<DashboardSettings />} />
          <Route path="tables" element={<DisplaySettings />} />
          <Route path="records" element={<OpenRecordSettings />} />
          <Route path="daily-plan" element={<DailyPlanSettings />} />
          <Route path="goals" element={<GoalsSettings />} />
          <Route path="pm-schedules" element={<PmSchedulesSettings />} />
          <Route path="motion" element={<MotionSettings />} />
          <Route path="login" element={<LoginPageSettings />} />
          <Route path="interface" element={<InterfaceSettings />} />
          <Route path="data-hub" element={<DataHubSettings />} />
          <Route path="map" element={<MapSettings />} />
          <Route path="finance-hub" element={<FinanceHubSettings />} />
        </Route>
        <Route path="alerts" element={<TabFrame tab="alerts" />}>
          <Route index element={<Navigate to="policy" replace />} />
          <Route path="policy" element={<Notifications />} />
          <Route path="mail" element={<><MailPolicy /><MailKinds /></>} />
          <Route path="rules" element={<AlertRules />} />
          <Route path="push" element={<WebPushSettings />} />
        </Route>
        <Route path="workflow" element={<TabFrame tab="workflow" />}>
          <Route index element={<Navigate to="editor" replace />} />
          <Route path="editor" element={<Studio />} />
          <Route path="columns" element={<SiteMasterColumns />} />
          <Route path="sequence" element={<SequenceSettings />} />
          <Route path="freeze" element={<Freeze />} />
          <Route path="idle" element={<Idle />} />
          <Route path="board" element={<KanbanWip />} />
          <Route path="coverage" element={<MatrixCoverageScreen />} />
          <Route path="simulate" element={<MatrixSimulateScreen />} />
        </Route>
        <Route path="sla" element={<TabFrame tab="sla" />}>
          <Route index element={<Navigate to="rules" replace />} />
          <Route path="rules" element={<SlaRules />} />
          <Route path="calendar" element={<Calendar />} />
          <Route path="weights" element={<WeightSets />} />
          <Route path="planned" element={<PlanRules />} />
        </Route>
        <Route path="registers" element={<TabFrame tab="registers" />}>
          <Route index element={<Navigate to="columns" replace />} />
          <Route path="columns" element={<RegisterColumns />} />
          <Route path="custom" element={<CustomRegisters />} />
          <Route path="lists" element={<Lists />} />
          <Route path="recycle" element={<RecycleBinScreen />} />
          <Route path="contractors" element={<><ContractorRules /><ContractorPerfThresholds /></>} />
          <Route path="gecol" element={<GecolOrderWarnings />} />
          <Route path="derive" element={<DeriveRulesScreen />} />
          <Route path="team-scope" element={<TeamScopeMatch />} />
          <Route path="issue-map" element={<IssueTaskMap />} />
        </Route>
        <Route path="documents" element={<TabFrame tab="documents" />}>
          <Route index element={<Navigate to="types" replace />} />
          <Route path="types" element={<DocumentLibrary />} />
          <Route path="library" element={<LegacyRedirect to="documents/types" />} />
          <Route path="forms" element={<FormTemplates />} />
          <Route path="archive" element={<ArchiveSettings />} />
          <Route path="media" element={<MediaSettingsScreen />} />
          <Route path="numbering" element={<NumberSequences />} />
          <Route path="search" element={<DocumentSearchIndex />} />
        </Route>
        <Route path="data" element={<TabFrame tab="data" />}>
          <Route index element={<Navigate to="imports" replace />} />
          <Route path="imports" element={<><Imports /><TemplateNoticeCard /><DuplicateRowsCard /></>} />
          <Route path="mapping" element={<TemplateMappingPanel />} />
          <Route path="historical" element={<HistoricalWaiver />} />
          <Route path="counts" element={<GecolHlcCounts />} />
          <Route path="export" element={<ExportSchedulesScreen />} />
          <Route path="structure" element={<StructureByTemplate />} />
          <Route path="reset" element={<DataReset />} />
        </Route>
        <Route path="security" element={<TabFrame tab="security" />}>
          <Route index element={<Navigate to="staff" replace />} />
          <Route path="staff" element={<StaffVisibility />} />
          <Route path="retention" element={<Retention />} />
          <Route path="dlp" element={<Dlp />} />
          <Route path="locks" element={<SecurityLocks />} />
          <Route path="limits" element={<OpsLimits />} />
          <Route path="alerts" element={<AlertSettingsPanel />} />
          <Route path="support" element={<SupportAccess />} />
          <Route path="newdevice" element={<NewDeviceCode />} />
          <Route path="passkeys" element={<Passkeys />} />
        </Route>
        {Object.entries(LEGACY_SETTINGS_PATHS).map(([old, to]) => <Route key={old} path={old} element={<LegacyRedirect to={to} />} />)}
      </Route>
    </Routes>
  );
}

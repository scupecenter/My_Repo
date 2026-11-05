import { useTranslation } from 'react-i18next';
import { NavLink, Navigate, Outlet, Route, Routes } from 'react-router-dom';
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
import { HistoricalWaiver } from './HistoricalWaiver';
import { Imports } from './Imports';

export const SETTINGS_TABS = ['calendar', 'sla', 'weights', 'freeze', 'dlp', 'idle', 'notifications', 'retention', 'staff-visibility', 'documents', 'team-scope', 'lists', 'contractor-rules', 'gecol-order', 'mail-kinds', 'historical-waiver', 'imports'] as const;

function Layout() {
  const { t } = useTranslation();
  const me = useMe(true);
  return (
    <div data-testid="page-settings">
      <h1 className="text-2xl font-bold">{t('nav.admin.settings')}</h1>
      <nav className="my-3 flex flex-wrap gap-1" aria-label={t('nav.admin.settings')}>
        {SETTINGS_TABS.filter((k) => k !== 'mail-kinds' || me.data?.is_system_admin).map((k) => <NavLink key={k} to={`/admin/settings/${k}`} data-testid={`settings-tab-${k}`} className={({ isActive }) => `btn ${isActive ? 'btn-accent' : ''}`}>{t(`settings.tab_${k}`)}</NavLink>)}
      </nav>
      <Outlet />
    </div>
  );
}

/** Mounted at `admin/settings/*`. */
export function SettingsRoutes() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Navigate to="calendar" replace />} />
        <Route path="calendar" element={<Calendar />} />
        <Route path="sla" element={<SlaRules />} />
        <Route path="weights" element={<WeightSets />} />
        <Route path="freeze" element={<Freeze />} />
        <Route path="dlp" element={<Dlp />} />
        <Route path="idle" element={<Idle />} />
        <Route path="notifications" element={<Notifications />} />
        <Route path="retention" element={<Retention />} />
        <Route path="staff-visibility" element={<StaffVisibility />} />
        <Route path="documents" element={<DocumentLibrary />} />
        <Route path="team-scope" element={<TeamScopeMatch />} />
        <Route path="lists" element={<Lists />} />
        <Route path="contractor-rules" element={<ContractorRules />} />
        <Route path="gecol-order" element={<GecolOrderWarnings />} />
        <Route path="mail-kinds" element={<MailKinds />} />
        <Route path="historical-waiver" element={<HistoricalWaiver />} />
        <Route path="imports" element={<Imports />} />
      </Route>
    </Routes>
  );
}

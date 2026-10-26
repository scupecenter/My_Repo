import { useTranslation } from 'react-i18next';
import { NavLink, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { Calendar } from './Calendar';
import { Notifications } from './Notifications';
import { Retention } from './Retention';
import { Dlp, Freeze, Idle } from './Rules';
import { SlaRules } from './SlaRules';
import { WeightSets } from './WeightSets';
import { StaffVisibility } from './StaffVisibility';

export const SETTINGS_TABS = ['calendar', 'sla', 'weights', 'freeze', 'dlp', 'idle', 'notifications', 'retention', 'staff-visibility'] as const;

function Layout() {
  const { t } = useTranslation();
  return (
    <div data-testid="page-settings">
      <h1 className="text-2xl font-bold">{t('nav.admin.settings')}</h1>
      <nav className="my-3 flex flex-wrap gap-1" aria-label={t('nav.admin.settings')}>
        {SETTINGS_TABS.map((k) => <NavLink key={k} to={`/admin/settings/${k}`} data-testid={`settings-tab-${k}`} className={({ isActive }) => `btn ${isActive ? 'btn-accent' : ''}`}>{t(`settings.tab_${k}`)}</NavLink>)}
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
      </Route>
    </Routes>
  );
}

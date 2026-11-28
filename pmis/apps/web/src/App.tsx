import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { setPasswordChangeHandler } from '@/api/client';
import { useSession } from '@/api/hooks';
import type { Session } from '@/api/types';
import { AnnouncementPopup } from '@/components/AnnouncementPopup';
import { Shell } from '@/components/Shell';
import { safeNext } from '@/lib/nextPath';
import { Home } from '@/components/Home';
import { PeopleAdminLayout } from '@/components/PeopleAdmin';
import { Approvals } from '@/pages/Approvals';
import { Inbox } from '@/pages/Inbox';
import { StatusUpdates } from '@/pages/StatusUpdates';
import { ContractorsReports } from '@/pages/ContractorsReports';
import { CompanyRecords } from '@/pages/CompanyRecords';
import { Companies } from '@/pages/Companies';
import { Workload } from '@/pages/Workload';
import { Dashboard } from '@/pages/Dashboard';
import { ManualItems } from '@/pages/ManualItems';
import { ChangePassword } from '@/pages/ChangePassword';
import { InviteAccept } from '@/pages/InviteAccept';
import { EmployeeId } from '@/pages/EmployeeId';
import { Login, USE_MOCKS } from '@/pages/Login';
import { ForgotPassword } from '@/pages/ForgotPassword';
import { ResetPassword } from '@/pages/ResetPassword';
import { MockM365, MockStepUp, StepUpDone } from '@/pages/MockM365';
import { MatrixPage } from '@/pages/Matrix';
import { MyWork } from '@/pages/MyWork';
import { DailyPlan } from '@/pages/DailyPlan';
import { RegisterPage, RegisterRecordPage } from '@/pages/Register';
import { RegisterBatch } from '@/pages/RegisterBatch';
import { DataHubPage } from '@/pages/DataHub';
import { FinanceHubPage } from '@/pages/FinanceHub';
import { CustomRegistersHub } from './pages/CustomRegistersHub';
import { TemplatesPage } from '@/pages/Templates';
import { LibraryForms } from '@/pages/library/Forms';
import { LibraryTemplates } from '@/pages/library/Templates';
import { ArchiveList, LibraryArchive } from '@/pages/library/Archive';
import { LibraryMedia } from '@/pages/library/Media';
import { ReconciliationPage } from '@/pages/Reconciliation';
import { AsBuiltItems } from '@/pages/AsBuiltItems';
import { MenuGroup } from './pages/MenuGroup';
import { Warehouse } from '@/pages/Warehouse';
import { Site } from '@/pages/Site';
import { Sites } from '@/pages/Sites';
import { NewSite } from '@/pages/NewSite';
import { Absence } from '@/pages/Absence';
import { AnnouncementResults } from '@/pages/AnnouncementResults';
import { Announcements } from '@/pages/Announcements';
import { Messages } from '@/pages/Messages';
import { Delegation } from '@/pages/Delegation';
import { Groups } from '@/pages/Groups';
import { Assignments } from '@/pages/Assignments';
import { Profiles } from '@/pages/Profiles';
import { Roles } from '@/pages/Roles';
import { UserDetailPage } from '@/pages/UserDetail';
import { Users } from '@/pages/Users';
import { Pending } from '@/pages/Pending';
import { Profile } from '@/pages/Profile';
import { SecurityLog } from '@/pages/SecurityLog';
import { ActivityReport } from '@/pages/logs/ActivityReport';
import { AuditLog } from '@/pages/logs/AuditLog';
import { FieldChanges } from '@/pages/logs/FieldChanges';
import { Deployments, JobRuns } from '@/pages/logs/JobRuns';
import { OnlineSessions } from '@/pages/logs/OnlineSessions';
import { SecurityAlerts } from '@/pages/logs/SecurityAlerts';
import { MailDelivery } from '@/pages/logs/MailDelivery';
import { IntegrityRuns } from '@/pages/logs/IntegrityRuns';
import { SystemLog } from '@/pages/logs/SystemLog';
import { SettingsRoutes } from '@/pages/settings/Settings';
import { FaviconSync } from '@/components/PublicLogo';

/** `/settings/...` is not a route of its own: Settings live under /admin/settings (review item 11), so the short address opens the same page instead of the placeholder. */
export function SettingsAlias() {
  const { pathname, search, hash } = useLocation();
  const rest = pathname.replace(/^\/settings\/?/, '');
  return <Navigate to={{ pathname: rest ? `/admin/settings/${rest}` : '/admin/settings/all', search, hash }} replace />;
}

/** The template mapping screen now lives in Settings > Data > Mapping (one home for settings); the old address keeps working. */
export function MappingRedirect() {
  const { search } = useLocation();
  return <Navigate to={{ pathname: '/admin/settings/data/mapping', search }} replace />;
}

function Soon() {
  const { t } = useTranslation();
  return <p className="text-mute" data-testid="page-soon">{t('common.soon')}</p>;
}

/** /login, with the page asked for as ?next= when it is an internal path other than the landing page. */
export function shareLoginTarget(loc: { pathname: string; search: string; hash: string }): string {
  const want = safeNext(`${loc.pathname}${loc.search}${loc.hash}`);
  return want && want !== '/' ? `/login?next=${encodeURIComponent(want)}` : '/login';
}

function Gate() {
  const s = useSession();
  if (s.isLoading) return null;
  const session = s.data;
  // an authenticated share link: after sign-in the person lands on the same page (their own role and permissions still apply)
  if (!session?.authenticated) return <Navigate to={shareLoginTarget(window.location)} replace />;
  // The announcement pop-up (ADR 0013) shows for every signed-in person, also on the screens below that stand alone.
  return <><AnnouncementPopup />{gated(session)}</>;
}

function gated(session: Session) {
  // A temporary password is waiting: this screen is the only one reachable, whatever the URL.
  if (session.must_change_password) return <ChangePassword forced />;
  if (session.needs_employee_id) return <EmployeeId />;
  if (session.status === 'pending_assignment') return <Pending session={session} />;
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Home />} />
        <Route path="change-password" element={<ChangePassword />} />
        <Route path="profile" element={<Profile />} />
        <Route path="my-work" element={<MyWork />} />
        <Route path="my-work/daily-plan" element={<DailyPlan />} />
        <Route path="approvals" element={<Approvals />} />
        <Route path="inbox" element={<Inbox />} />
        <Route path="workload" element={<Workload />} />
        <Route path="reports/contractors" element={<ContractorsReports />} />
        <Route path="companies" element={<Companies />} />
        <Route path="companies/:id" element={<CompanyRecords />} />
        <Route path="status-updates" element={<StatusUpdates />} />
        <Route path="dashboard" element={<Dashboard />} />
        <Route path="dashboard/manual-items" element={<ManualItems />} />
        <Route path="sites" element={<Sites />} />
        <Route path="sites/new" element={<NewSite />} />
        <Route path="sites/:siteId" element={<Site />} />
        <Route path="menu/:id" element={<MenuGroup />} />
        <Route path="registers/:key" element={<RegisterPage />} />
        {/* V5: a record on its own page (the person chose so in Settings > Screens > Records) */}
        <Route path="registers/:key/records/:id" element={<RegisterRecordPage />} />
        <Route path="warehouse" element={<Warehouse />} />
        <Route path="as-built/items" element={<AsBuiltItems />} />
        <Route path="registers/:key/batches/:batchId" element={<RegisterBatch />} />
        <Route path="data-hub" element={<DataHubPage />} />
        <Route path="finance-hub" element={<FinanceHubPage />} />
        <Route path="custom-registers" element={<CustomRegistersHub />} />
        <Route path="templates" element={<TemplatesPage />} />
        {/* W5: Library (Forms and Archive) */}
        <Route path="library" element={<Navigate to="/library/forms" replace />} />
        <Route path="library/forms" element={<LibraryForms />} />
        <Route path="library/templates" element={<LibraryTemplates />} />
        <Route path="library/archive" element={<LibraryArchive />} />
        <Route path="library/media" element={<LibraryMedia />} />
        <Route path="library/archive/:docCode" element={<ArchiveList />} />
        <Route path="templates/batches/:batchId" element={<RegisterBatch />} />
        <Route path="templates/master-import" element={<ReconciliationPage />} />
        <Route path="templates/mapping" element={<MappingRedirect />} />
        <Route path="absence" element={<Absence />} />
        <Route path="messages" element={<Messages />} />
        <Route path="messages/:threadId" element={<Messages />} />
        <Route path="admin/announcements" element={<Announcements />} />
        <Route path="admin/announcements/:id" element={<AnnouncementResults />} />
        <Route element={<PeopleAdminLayout />}>
          <Route path="admin/users" element={<Users />} />
          <Route path="admin/users/:userId" element={<UserDetailPage />} />
          <Route path="admin/online" element={<Users />} />
          <Route path="admin/assignments" element={<Assignments />} />
          <Route path="admin/roles" element={<Roles />} />
          <Route path="admin/profiles" element={<Profiles />} />
          <Route path="admin/groups" element={<Groups />} />
          <Route path="admin/delegation" element={<Delegation />} />
          <Route path="admin/matrix" element={<MatrixPage />} />
        </Route>
        <Route path="admin/settings/*" element={<SettingsRoutes />} />
        <Route path="admin/security-log" element={<SecurityLog />} />
        <Route path="audit" element={<AuditLog />} />
        <Route path="admin/logs/field-changes" element={<FieldChanges />} />
        <Route path="admin/logs/online" element={<OnlineSessions />} />
        <Route path="admin/logs/alerts" element={<SecurityAlerts />} />
        <Route path="admin/logs/job-runs" element={<JobRuns />} />
        <Route path="admin/logs/deployments" element={<Deployments />} />
        <Route path="admin/logs/activity-report" element={<ActivityReport />} />
        <Route path="admin/logs/mail" element={<MailDelivery />} />
        <Route path="admin/logs/system" element={<SystemLog />} />
        <Route path="admin/logs/integrity" element={<IntegrityRuns />} />
        <Route path="settings/*" element={<SettingsAlias />} />
        <Route path="*" element={<Soon />} />
      </Route>
    </Routes>
  );
}

export function App() {
  const qc = useQueryClient();
  // Any API call that answers 403 password_change_required sends the user to the change-password screen.
  useEffect(() => {
    setPasswordChangeHandler(() => qc.setQueryData<Session>(['session'], (s) => (s && !s.must_change_password ? { ...s, must_change_password: true } : s)));
    return () => setPasswordChangeHandler(null);
  }, [qc]);
  return (
    <>
    <FaviconSync />
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/invite/:token" element={<InviteAccept />} />
      <Route path="/step-up-done" element={<StepUpDone />} />
      {USE_MOCKS && <Route path="/mock-m365" element={<MockM365 />} />}
      {USE_MOCKS && <Route path="/mock-m365/step-up" element={<MockStepUp />} />}
      <Route path="/*" element={<Gate />} />
    </Routes>
    </>
  );
}

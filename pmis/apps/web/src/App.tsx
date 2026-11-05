import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, Route, Routes } from 'react-router-dom';
import { setPasswordChangeHandler } from '@/api/client';
import { useSession } from '@/api/hooks';
import type { Session } from '@/api/types';
import { AnnouncementPopup } from '@/components/AnnouncementPopup';
import { Shell } from '@/components/Shell';
import { PeopleAdminLayout } from '@/components/PeopleAdmin';
import { Approvals } from '@/pages/Approvals';
import { Inbox } from '@/pages/Inbox';
import { StatusUpdates } from '@/pages/StatusUpdates';
import { ContractorsReports } from '@/pages/ContractorsReports';
import { Workload } from '@/pages/Workload';
import { Dashboard } from '@/pages/Dashboard';
import { ManualItems } from '@/pages/ManualItems';
import { ChangePassword } from '@/pages/ChangePassword';
import { EmployeeId } from '@/pages/EmployeeId';
import { Login, USE_MOCKS } from '@/pages/Login';
import { MockM365, MockStepUp, StepUpDone } from '@/pages/MockM365';
import { MatrixPage } from '@/pages/Matrix';
import { MyWork } from '@/pages/MyWork';
import { RegisterPage } from '@/pages/Register';
import { RegisterBatch } from '@/pages/RegisterBatch';
import { TemplatesPage } from '@/pages/Templates';
import { ReconciliationPage } from '@/pages/Reconciliation';
import { TemplateMappingPage } from '@/pages/TemplateMapping';
import { AsBuiltItems } from '@/pages/AsBuiltItems';
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
import { SettingsRoutes } from '@/pages/settings/Settings';

function Soon() {
  const { t } = useTranslation();
  return <p className="text-mute" data-testid="page-soon">{t('common.soon')}</p>;
}

function Gate() {
  const s = useSession();
  if (s.isLoading) return null;
  const session = s.data;
  if (!session?.authenticated) return <Navigate to="/login" replace />;
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
        <Route index element={<Navigate to="/my-work" replace />} />
        <Route path="change-password" element={<ChangePassword />} />
        <Route path="profile" element={<Profile />} />
        <Route path="my-work" element={<MyWork />} />
        <Route path="approvals" element={<Approvals />} />
        <Route path="inbox" element={<Inbox />} />
        <Route path="workload" element={<Workload />} />
        <Route path="reports/contractors" element={<ContractorsReports />} />
        <Route path="status-updates" element={<StatusUpdates />} />
        <Route path="dashboard" element={<Dashboard />} />
        <Route path="dashboard/manual-items" element={<ManualItems />} />
        <Route path="sites" element={<Sites />} />
        <Route path="sites/new" element={<NewSite />} />
        <Route path="sites/:siteId" element={<Site />} />
        <Route path="registers/:key" element={<RegisterPage />} />
        <Route path="warehouse" element={<Warehouse />} />
        <Route path="as-built/items" element={<AsBuiltItems />} />
        <Route path="registers/:key/batches/:batchId" element={<RegisterBatch />} />
        <Route path="templates" element={<TemplatesPage />} />
        <Route path="templates/batches/:batchId" element={<RegisterBatch />} />
        <Route path="templates/master-import" element={<ReconciliationPage />} />
        <Route path="templates/mapping" element={<TemplateMappingPage />} />
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
        <Route path="admin/logs/integrity" element={<IntegrityRuns />} />
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
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/step-up-done" element={<StepUpDone />} />
      {USE_MOCKS && <Route path="/mock-m365" element={<MockM365 />} />}
      {USE_MOCKS && <Route path="/mock-m365/step-up" element={<MockStepUp />} />}
      <Route path="/*" element={<Gate />} />
    </Routes>
  );
}

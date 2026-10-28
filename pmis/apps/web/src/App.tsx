import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, Route, Routes } from 'react-router-dom';
import { setPasswordChangeHandler } from '@/api/client';
import { useSession } from '@/api/hooks';
import type { Session } from '@/api/types';
import { Shell } from '@/components/Shell';
import { Approvals } from '@/pages/Approvals';
import { ChangePassword } from '@/pages/ChangePassword';
import { EmployeeId } from '@/pages/EmployeeId';
import { Login, USE_MOCKS } from '@/pages/Login';
import { MockM365, MockStepUp, StepUpDone } from '@/pages/MockM365';
import { MatrixPage } from '@/pages/Matrix';
import { MyWork } from '@/pages/MyWork';
import { Site } from '@/pages/Site';
import { Sites } from '@/pages/Sites';
import { Absence } from '@/pages/Absence';
import { Delegation } from '@/pages/Delegation';
import { Groups } from '@/pages/Groups';
import { Roles } from '@/pages/Roles';
import { UserDetailPage } from '@/pages/UserDetail';
import { Users } from '@/pages/Users';
import { Pending } from '@/pages/Pending';
import { OnlineNow } from '@/pages/OnlineNow';
import { SecurityLog } from '@/pages/SecurityLog';
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
  // A temporary password is waiting: this screen is the only one reachable, whatever the URL.
  if (session.must_change_password) return <ChangePassword forced />;
  if (session.needs_employee_id) return <EmployeeId />;
  if (session.status === 'pending_assignment') return <Pending session={session} />;
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Navigate to="/my-work" replace />} />
        <Route path="change-password" element={<ChangePassword />} />
        <Route path="my-work" element={<MyWork />} />
        <Route path="approvals" element={<Approvals />} />
        <Route path="sites" element={<Sites />} />
        <Route path="sites/:siteId" element={<Site />} />
        <Route path="admin/users" element={<Users />} />
        <Route path="admin/users/:userId" element={<UserDetailPage />} />
        <Route path="admin/roles" element={<Roles />} />
        <Route path="admin/groups" element={<Groups />} />
        <Route path="admin/delegation" element={<Delegation />} />
        <Route path="absence" element={<Absence />} />
        <Route path="admin/matrix" element={<MatrixPage />} />
        <Route path="admin/settings/*" element={<SettingsRoutes />} />
        <Route path="admin/security-log" element={<SecurityLog />} />
        <Route path="admin/online" element={<OnlineNow />} />
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

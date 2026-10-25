import { useTranslation } from 'react-i18next';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useSession } from '@/api/hooks';
import { Shell } from '@/components/Shell';
import { Approvals } from '@/pages/Approvals';
import { EmployeeId } from '@/pages/EmployeeId';
import { Login, USE_MOCKS } from '@/pages/Login';
import { MockM365, MockStepUp, StepUpDone } from '@/pages/MockM365';
import { MyWork } from '@/pages/MyWork';
import { Pending } from '@/pages/Pending';

function Soon() {
  const { t } = useTranslation();
  return <p className="text-mute" data-testid="page-soon">{t('common.soon')}</p>;
}

function Gate() {
  const s = useSession();
  if (s.isLoading) return null;
  const session = s.data;
  if (!session?.authenticated) return <Navigate to="/login" replace />;
  if (session.needs_employee_id) return <EmployeeId />;
  if (session.status === 'pending_assignment') return <Pending session={session} />;
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Navigate to="/my-work" replace />} />
        <Route path="my-work" element={<MyWork />} />
        <Route path="approvals" element={<Approvals />} />
        <Route path="*" element={<Soon />} />
      </Route>
    </Routes>
  );
}

export function App() {
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

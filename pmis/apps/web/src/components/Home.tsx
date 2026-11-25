import { Navigate } from 'react-router-dom';
import { useMe } from '@/api/hooks';
import { landingPath } from '@/lib/landing';

/** The page after sign-in and on "/": My Work, or the Dashboard for someone whose only viewable module is the dashboard (0163). */
export function Home() {
  const me = useMe(true);
  if (me.isLoading) return null;
  return <Navigate to={landingPath(me.data?.effective.nav)} replace />;
}

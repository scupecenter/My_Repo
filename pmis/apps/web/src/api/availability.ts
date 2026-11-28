import { useQuery } from '@tanstack/react-query';
import { api } from './client';
import type { Absence, Page } from './types';
import { availabilityOn, awayOn, today } from '@/lib/availability';

/** Who is away today, among the absences this person may read (the same list as the Absence screen, same cache). Quiet when the switch is off or the list cannot be read. */
export function useAway(employeeId: string | null | undefined): string | null {
  const on = !!employeeId && availabilityOn();
  const q = useQuery({ queryKey: ['absences'], enabled: on, retry: false, staleTime: 60_000, queryFn: () => api.get<Page<Absence>>('/absences').then((r) => r.items) });
  return on ? (awayOn(q.data, today()).get(employeeId!) ?? null) : null;
}

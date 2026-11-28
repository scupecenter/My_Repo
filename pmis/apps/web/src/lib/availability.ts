import { loadPref, savePref } from '@/lib/localPref';

/** Availability on people chips (improvement list item 19). One switch per browser, on by default (Settings, Screens, Records). */
export const AVAILABILITY_KEY = 'pmis.availability';
export const availabilityOn = (): boolean => loadPref<boolean>(AVAILABILITY_KEY, true) !== false;
export const setAvailability = (on: boolean): void => savePref(AVAILABILITY_KEY, on);

export type AbsenceLike = { user: { employee_id?: string | null }; kind: string; from_date: string; to_date: string };

/** Local calendar date, the same kind of value the absence dates are. */
export const today = (d = new Date()): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Employee id to absence kind for the people who are away on `day`. Only the absences the caller may already read are in the list, so nobody learns more than the Absence screen shows. */
export function awayOn(list: AbsenceLike[] | undefined, day: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const a of list ?? []) if (a.user.employee_id && a.from_date <= day && day <= a.to_date) m.set(a.user.employee_id, a.kind);
  return m;
}

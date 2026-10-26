/** Today's date (YYYY-MM-DD) in Africa/Tripoli, the zone every effective date is checked in. */
export const tripoliToday = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tripoli', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

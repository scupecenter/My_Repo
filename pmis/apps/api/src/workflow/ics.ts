/** A small iCalendar (RFC 5545) writer for the caller's own tasks. All-day events; text escaped and lines folded at 75 octets. */
export interface IcsTask {
  id: string;
  site_code: string;
  task_code: string;
  name_en: string;
  stage_code: string;
  state: string;
  due: string | null; // YYYY-MM-DD
}

const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** Fold a content line: no line longer than 75 octets, continuation lines start with one space. */
export function foldLine(line: string): string {
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = '';
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

const compact = (iso: string): string => iso.replace(/-/g, '');

function nextDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function buildIcs(tasks: IcsTask[], stamp: Date): string {
  const dtstamp = stamp.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//GSDN Workspace//My Work//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:GSDN My Work'];
  for (const t of tasks) {
    if (!t.due || !/^\d{4}-\d{2}-\d{2}$/.test(t.due)) continue;
    lines.push(
      'BEGIN:VEVENT',
      `UID:${t.id}@gsdn-workspace`,
      `DTSTAMP:${dtstamp}`,
      `DTSTART;VALUE=DATE:${compact(t.due)}`,
      `DTEND;VALUE=DATE:${compact(nextDay(t.due))}`,
      `SUMMARY:${esc(`${t.site_code} ${t.name_en}`)}`,
      `DESCRIPTION:${esc(`${t.task_code} | ${t.stage_code} | ${t.state}`)}`,
      'TRANSP:TRANSPARENT',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

/** D4 (0.15.460): one dated line of the personal calendar feed. `kind` is planned (an open task pinned to the person) or permit_expiry (an own permit). */
export interface FeedEvent {
  uid: string;
  kind: 'planned' | 'permit_expiry';
  date: string; // YYYY-MM-DD
  site_code: string;
  title: string;
  code: string;
}

/** The personal feed as an iCalendar body: all-day events, no attendees, no links, no record text beyond site code, title and code. */
export function buildFeedIcs(events: FeedEvent[], stamp: Date): string {
  const dtstamp = stamp.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//GSDN Workspace//Personal feed//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:GSDN My dates', 'REFRESH-INTERVAL;VALUE=DURATION:PT6H'];
  for (const e of events) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date)) continue;
    lines.push(
      'BEGIN:VEVENT',
      `UID:${e.uid}@gsdn-feed`,
      `DTSTAMP:${dtstamp}`,
      `DTSTART;VALUE=DATE:${compact(e.date)}`,
      `DTEND;VALUE=DATE:${compact(nextDay(e.date))}`,
      `SUMMARY:${esc(`${e.site_code} ${e.title}`)}`,
      ...(e.code ? [`DESCRIPTION:${esc(e.code)}`] : []),
      'TRANSP:TRANSPARENT',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

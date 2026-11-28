import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isMappedTitleLiteral } from './notificationTitle';

/**
 * CI guard (visual review 2026-11-27, item 1): every English notification title the server writes from a fixed literal (the workflow helpers and the
 * direct INSERTs into notifications) must have a translation in `notificationTitle.ts`. A new notification with a new title fails here until it is
 * mapped. The sources that pass a title in from a caller (a parameter, a template, an alert rule) cannot be checked by text and are listed below with
 * the reason; the central notification policy moves those to a server-side kind with params.
 */
const MIG = join(__dirname, '../../../api/prisma/migrations');
const helper = /\b(?:wf_notify|reg_notify|qc_notify_level|qc_notify|wf_notify_admins)\(/g;
const insert = /INSERT INTO (?:public\.)?notifications\s*\(([^)]*)\)\s*(VALUES\s*\(|SELECT\s)/gi;

function split(s: string): string[] {
  const out: string[] = []; let d = 0; let cur = ''; let q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { cur += c; if (c === "'") { if (s[i + 1] === "'") { cur += "'"; i++; } else q = false; } }
    else if (c === "'") { q = true; cur += c; }
    else if (c === '(') { d++; cur += c; }
    else if (c === ')') { d--; cur += c; }
    else if (c === ',' && d === 0) { out.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  out.push(cur.trim()); return out;
}
function bodyFrom(s: string, start: number): string {
  let d = 0; let q = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === "'") { if (s[i + 1] === "'") i++; else q = false; } }
    else if (c === "'") q = true;
    else if (c === '(') d++;
    else if (c === ')') { if (d === 0) return s.slice(start, i); d--; }
  }
  return '';
}
const lits = (e: string) => [...e.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));

/** Titles that come from a caller or a template, by migration: not checkable by text. */
const CALLER_SUPPLIED = new Set([
  'p_title', 'left(p_title, 300)', 'ttl', 'v_title', 'NEW.title',
  "coalesce(nullif(p_title ->> u.loc, ''), p_title ->> 'en')",
]);

describe('every fixed server notification title has a translation', () => {
  const unmapped: string[] = []; const dynamic = new Set<string>(); let checked = 0;
  for (const dir of readdirSync(MIG).sort()) {
    let s = ''; try { s = readFileSync(join(MIG, dir, 'migration.sql'), 'utf8'); } catch { continue; }
    for (const m of s.matchAll(helper)) {
      const args = split(bodyFrom(s, (m.index ?? 0) + m[0].length));
      const l = args.length > 2 ? lits(args[2]) : [];
      if (args.length > 2 && /^'/.test(args[2])) for (const x of l) { checked++; if (/^[A-Z][A-Za-z ]+[a-z]/.test(x) && !isMappedTitleLiteral(x)) unmapped.push(`${dir}: ${x}`); }
    }
    for (const m of s.matchAll(insert)) {
      const cols = m[1].split(',').map((c) => c.trim()); const ti = cols.indexOf('title'); if (ti < 0) continue;
      let b = '';
      if (/^VALUES/i.test(m[2])) b = bodyFrom(s, (m.index ?? 0) + m[0].length);
      else { const rest = s.slice((m.index ?? 0) + m[0].length); const e = rest.search(/\sFROM\s|;/); b = e < 0 ? '' : rest.slice(0, e); }
      const expr = split(b)[ti]; if (!expr) continue;
      const l = lits(expr).filter((x) => /^[A-Z][A-Za-z ]+[a-z]/.test(x) && x !== 'reject' && x !== 'expired' && x !== 'soon' && x !== 'en');
      if (!l.length) { if (!CALLER_SUPPLIED.has(expr.replace(/\s+/g, ' '))) dynamic.add(`${dir}: ${expr.slice(0, 60)}`); continue; }
      for (const x of l) { checked++; if (!isMappedTitleLiteral(x)) unmapped.push(`${dir}: ${x}`); }
    }
  }
  it('has no unmapped fixed title', () => { expect(checked).toBeGreaterThan(40); expect(unmapped).toEqual([]); });
  it('has no new caller-supplied title source', () => { expect([...dynamic]).toEqual([]); });
});

import { Prisma } from '@prisma/client';
import { likePattern } from './cursor';
import { problems } from './problem';

/** W8 item 5 (contract 0.15.64): at most this many codes in one pasted list. */
export const MAX_PASTED_CODES = 1000;

/**
 * The search text of a site list (`q`), read the same way on every site-data list (GET /sites, GET /site360/{menu}/rows, the register records,
 * the approvals inbox and My Work):
 * - one token (no separator) keeps the "contains" search on code and name;
 * - two or more tokens, separated by spaces, new lines, tabs, commas or semicolons (cells copied from Excel), are a pasted list: each token
 *   matches Site ID or Site Owner ID exactly, ignoring case. Duplicates are dropped; more than 1000 distinct codes answer 422.
 */
export type SiteSearch = { kind: 'none' } | { kind: 'contains'; text: string } | { kind: 'list'; codes: string[] };

export function parseSiteSearch(raw: string | undefined, path = '/q'): SiteSearch {
  const text = (raw ?? '').trim();
  if (!text) return { kind: 'none' };
  const tokens = text.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
  if (tokens.length < 2) return { kind: 'contains', text: tokens[0] ?? text };
  const codes = [...new Set(tokens.map((x) => x.toUpperCase()))];
  if (codes.length > MAX_PASTED_CODES) throw problems.validation([{ path, code: 'too_many_codes', message: `At most ${MAX_PASTED_CODES} Site IDs in one search.` }]);
  if (codes.some((c) => c.length > 100)) throw problems.validation([{ path, code: 'invalid', message: 'A Site ID is at most 100 characters.' }]);
  return { kind: 'list', codes };
}

/**
 * The condition of a search on the sites table (alias `s` by default). A contains search also matches the Site Owner ID and the name;
 * `extra` adds more columns to the contains search only (for example a task code). Parameterised, never concatenated.
 */
export function siteSearchCond(s: SiteSearch, alias = 's', extra: Prisma.Sql[] = []): Prisma.Sql | null {
  const a = Prisma.raw(alias);
  if (s.kind === 'none') return null;
  if (s.kind === 'list') return Prisma.sql`(upper(${a}.site_code) = ANY(${s.codes}::text[]) OR upper(${a}.owner_site_id) = ANY(${s.codes}::text[]))`;
  const p = likePattern(s.text);
  const more = extra.map((e) => Prisma.sql` OR ${e} ILIKE ${p}`);
  return Prisma.sql`(${a}.site_code ILIKE ${p} OR ${a}.owner_site_id ILIKE ${p} OR ${a}.name ILIKE ${p}${more.length ? Prisma.join(more, '') : Prisma.empty})`;
}

/**
 * The scope of the "found / not found" answer on `sites s`: active sites in EVERY given region set (the intersection; null = no limit from
 * that set, an empty set = nothing). Pass the regions of the screen's own module AND the caller's `sites` view regions, so the answer never
 * says whether a site exists in a region where the caller may not see sites (security review 2026-11-24).
 */
export function siteScope(...regionSets: (number[] | null)[]): Prisma.Sql {
  const conds: Prisma.Sql[] = [Prisma.sql`s.is_active`];
  for (const r of regionSets) if (r !== null) conds.push(Prisma.sql`s.region_id = ANY(${r}::int[])`);
  return Prisma.join(conds, ' AND ');
}

/** What a pasted search found, as the chip shows it ("Sites: 3 pasted, 2 found") with the codes not found. */
export interface PastedSearchDto {
  pasted: number;
  found: number;
  not_found: string[];
}

type RawTx = { $queryRaw<T = unknown>(query: Prisma.Sql): Prisma.PrismaPromise<T> };

/**
 * The pasted codes that match no site the caller may see on this screen. `scope` is the visibility condition of the screen on `sites s`
 * (active sites in the caller's regions); row security applies as well, because the query runs in the caller's transaction. Other filters
 * are not part of it: a code is "found" when the site exists for the caller, even if a filter hides its row, so the list never says
 * "not found" for a site the caller can open, and never reveals a site the caller cannot see.
 */
export async function pastedSearchResult(tx: RawTx, s: SiteSearch, scope: Prisma.Sql): Promise<PastedSearchDto | undefined> {
  if (s.kind !== 'list') return undefined;
  const rows = await tx.$queryRaw<{ code: string }[]>(Prisma.sql`
    SELECT t.code FROM unnest(${s.codes}::text[]) WITH ORDINALITY AS t(code, n)
    WHERE NOT EXISTS (SELECT 1 FROM sites s WHERE ${scope} AND (upper(s.site_code) = t.code OR upper(s.owner_site_id) = t.code))
    ORDER BY t.n`);
  const notFound = rows.map((r) => r.code);
  return { pasted: s.codes.length, found: s.codes.length - notFound.length, not_found: notFound };
}

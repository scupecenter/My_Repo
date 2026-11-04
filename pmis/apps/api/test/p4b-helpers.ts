import { randomBytes } from 'node:crypto';
import type { Client as PgClient } from 'pg';

/**
 * Fixtures of P4b (migration 0061), written straight into the database as the superuser, the way the approval of a Contractors record projects
 * them: an external party with its contracts, and a team with its specialization codes.
 */
const tag = (): string => randomBytes(4).toString('hex');

export interface ContractOpts {
  scopes?: string[] | null;
  start?: string | null;
  end?: string | null;
  status?: 'active' | 'suspended' | 'terminated' | 'expired';
}

/** A company (external party) with one contract (default: every scope through 2034, active). */
export async function partyWithContract(db: PgClient, o: ContractOpts & { name?: string; type?: string; noContract?: boolean } = {}): Promise<string> {
  const p = await db.query(`INSERT INTO external_parties (name, type) VALUES ($1, $2::"ExternalPartyType") RETURNING id`, [o.name ?? `P4B Co ${tag()}`, o.type ?? 'cw_contractor']);
  const id = p.rows[0].id as string;
  if (!o.noContract) await addContract(db, id, o);
  return id;
}

export async function addContract(db: PgClient, party: string, o: ContractOpts = {}): Promise<string> {
  const c = await db.query(
    `INSERT INTO external_party_contracts (id, party_id, contract_ref, scopes, start_date, end_date, status, origin)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 'contract') RETURNING id`,
    [party, `C-${tag()}`, o.scopes === undefined ? null : o.scopes, o.start === undefined ? '2025-01-01' : o.start, o.end === undefined ? '2034-12-31' : o.end, o.status ?? 'active'],
  );
  return c.rows[0].id as string;
}

/** A team of the party with catalogue codes (or only a legacy text when codes is empty). */
export async function teamOf(db: PgClient, party: string, o: { codes?: string[]; legacy?: string | null; teamType?: string | null; certExpiry?: string | null; lead?: string | null } = {}): Promise<string> {
  const t = await db.query(
    `INSERT INTO external_teams (party_id, name, team_type, specialization, safety_cert_expiry, lead_user_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [party, `P4B Team ${tag()}`, o.teamType ?? null, o.legacy ?? null, o.certExpiry ?? null, o.lead ?? null],
  );
  const id = t.rows[0].id as string;
  for (const c of o.codes ?? []) await db.query('INSERT INTO external_team_specializations (team_id, code) VALUES ($1, $2)', [id, c]);
  return id;
}

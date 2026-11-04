#!/usr/bin/env node
// Signs a session context for app_begin (migration 0069) the way the API does, so the db-security cases can start a verified context from psql.
//
//   node sign-context.mjs <txid> [<user-id>|-] [name=value ...]
//
// Prints one JSON line {"ctx": {...}, "sig": "<hex>"}; psql reads it with \set wire `node ... :txid ...` and calls
//   SELECT app_begin(:'wire'::jsonb -> 'ctx', decode(:'wire'::jsonb ->> 'sig', 'hex')) AS began \gset
//
// The key comes from PMIS_SECSUITE_CONTEXT_KEY (hex), the test key the runner loaded into pmis_context_keys. It is a test-only key and is never printed.
// Options (all optional): issued=<seconds from now, negative = in the past>, key=wrong (sign with a key the database does not hold), via=, session=,
// stepup=<seconds from now>, mfa=true|false, ip=, request=, job=, on_behalf=, sigtxid=<another transaction id to sign for>.
//
// This file is an independent implementation of the canonical text (app_ctx_canon in 0069); apps/api/src/db/session-context.ts is the production one.

import { createHash, createHmac } from 'node:crypto';

const FIELDS = ['v', 'user_id', 'on_behalf', 'session_id', 'auth_method', 'mfa', 'stepup_until', 'via', 'request_id', 'ip', 'user_agent', 'device', 'job_name', 'issued_at'];

const [txid, user, ...rest] = process.argv.slice(2);
if (!txid) {
  console.error('usage: sign-context.mjs <txid> [<user-id>|-] [name=value ...]');
  process.exit(2);
}
const opt = Object.fromEntries(rest.map((a) => [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]));

const keyHex = process.env.PMIS_SECSUITE_CONTEXT_KEY;
if (!keyHex || !/^[0-9a-f]{64}$/i.test(keyHex)) {
  console.error('PMIS_SECSUITE_CONTEXT_KEY is not set to 64 hex characters');
  process.exit(2);
}
let key = Buffer.from(keyHex, 'hex');
if (opt.key === 'wrong') key = createHash('sha256').update(key).update('wrong').digest();

const now = Date.now();
const iso = (secs) => new Date(now + Number(secs) * 1000).toISOString();
const ctx = {
  v: '1',
  user_id: user && user !== '-' ? user : null,
  on_behalf: opt.on_behalf ?? null,
  session_id: opt.session ?? null,
  auth_method: 'local',
  mfa: opt.mfa === undefined ? null : opt.mfa === 'true',
  stepup_until: opt.stepup !== undefined ? iso(opt.stepup) : null,
  via: opt.via ?? 'manual',
  request_id: opt.request ?? 'secsuite',
  ip: opt.ip ?? null,
  user_agent: null,
  device: null,
  job_name: opt.job ?? null,
  issued_at: iso(opt.issued ?? 0),
};
const canon = FIELDS.map((k) => {
  const v = ctx[k];
  if (v === null || v === undefined) return '-';
  const s = String(v);
  return `${Buffer.byteLength(s, 'utf8')}:${s}`;
}).join('|');
const sig = createHmac('sha256', key).update(`begin|${opt.sigtxid ?? txid}|${canon}`, 'utf8').digest('hex');
process.stdout.write(JSON.stringify({ ctx, sig }));

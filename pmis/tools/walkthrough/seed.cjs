// Installs the context key from the env file ($WALK_ENV) and bootstraps the first System Admin (employee id 9001, password Walk-Admin-Pass-2026), as the installer and the test setup do.
const path = require('node:path');
const api = path.resolve(__dirname, '../../apps/api/node_modules');
const { Client } = require(path.join(api, 'pg'));
const argon2 = require(path.join(api, 'argon2'));
(async () => {
  const db = new Client({ connectionString: process.env.WALK_SUPER_URL || 'postgresql://postgres@127.0.0.1:5433/pmis_walk' }); await db.connect();
  const hash = await argon2.hash('Walk-Admin-Pass-2026', { type: argon2.argon2id, memoryCost: 4096, timeCost: 2, parallelism: 1 });
  const key = /^PMIS_CONTEXT_KEY=(.+)$/m.exec(require('node:fs').readFileSync(process.env.WALK_ENV, 'utf8'))[1].trim();
  await db.query('SELECT app_ctx_key_install($1)', [key]);
  await db.query('SELECT idm_bootstrap_admin($1,$2,$3,$4,$5)', ['walk.admin@example.test', 'Walk Admin', '9001', '+218910000001', hash]);
  await db.end(); console.log('SEED_DONE');
})().catch((e) => { console.error(e.message); process.exit(1); });

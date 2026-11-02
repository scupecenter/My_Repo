import { stdin } from 'node:process';
import { PASSWORD_MAX, PASSWORD_MIN, passwordPolicyErrors } from './auth/password.policy';
import { hashPassword } from './auth/password.service';
import { generateEnrolCode, hashEnrolCode, normaliseEnrolCode, parseEncKey } from './auth/totp';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stdin) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * `node dist/cli.js hash-password`: reads one password from stdin (one trailing newline is dropped) and prints its argon2id
 * PHC hash. The installer feeds it to idm_bootstrap_admin. A weak password exits 1 with the rules it broke. Context-dependent
 * rules (email, employee ID, phone) can be given as environment variables PMIS_EMAIL, PMIS_EMPLOYEE_ID, PMIS_PHONE.
 */
/**
 * `node dist/cli.js enrol-code <user-uuid>`: makes a one-time two-factor enrolment code for that user and prints "CODE HASH" on one line
 * (the code as XXXX-XXXX, then its keyed hash). The key is TOTP_ENC_KEY from the environment, the same one the API uses. The installer script
 * tools/install/reset-two-factor.sh gives the hash to idm_installer_reset_two_factor and shows the code once. The database never sees the code.
 */
function enrolCode(userId: string | undefined): number {
  if (!userId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
    console.error('usage: TOTP_ENC_KEY=... node dist/cli.js enrol-code <user-uuid>');
    return 2;
  }
  const key = parseEncKey(process.env.TOTP_ENC_KEY ?? '');
  if (!key) {
    console.error('TOTP_ENC_KEY must be set to 32 bytes (64 hex characters or base64), the same value as in pmis.env.');
    return 1;
  }
  const code = generateEnrolCode();
  process.stdout.write(`${code} ${hashEnrolCode(key, userId, normaliseEnrolCode(code))}\n`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  if (argv[0] === 'enrol-code') return enrolCode(argv[1]);
  if (argv[0] !== 'hash-password') {
    console.error('usage: node dist/cli.js hash-password < password-file\n       TOTP_ENC_KEY=... node dist/cli.js enrol-code <user-uuid>');
    return 2;
  }
  const password = (await readStdin()).replace(/\r?\n$/, '');
  const errors = passwordPolicyErrors(
    password,
    { email: process.env.PMIS_EMAIL, employeeId: process.env.PMIS_EMPLOYEE_ID, phone: process.env.PMIS_PHONE },
    '/password',
  );
  if (errors.length > 0) {
    console.error(`The password is not accepted (use ${PASSWORD_MIN} to ${PASSWORD_MAX} characters, nothing common, nothing that contains your email name, employee ID or phone):`);
    for (const e of errors) console.error(`  - ${e.message ?? e.code}`);
    return 1;
  }
  process.stdout.write(`${await hashPassword(password)}\n`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  () => {
    console.error('Could not hash the password.');
    process.exit(1);
  },
);

import { stdin } from 'node:process';
import { PASSWORD_MAX, PASSWORD_MIN, passwordPolicyErrors } from './auth/password.policy';
import { hashPassword } from './auth/password.service';

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
async function main(argv: string[]): Promise<number> {
  if (argv[0] !== 'hash-password') {
    console.error('usage: node dist/cli.js hash-password < password-file');
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

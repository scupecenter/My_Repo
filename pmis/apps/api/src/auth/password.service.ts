import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { randomBytes } from 'node:crypto';

export const ARGON2_OPTIONS = { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 } as const;

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false; // malformed hash: treat as a mismatch
  }
}

/** argon2id (64 MiB, 3 passes, 1 lane). A dummy verify keeps the timing of "no such account" close to "wrong password". */
@Injectable()
export class PasswordService {
  private dummy: Promise<string> | undefined;

  hash(password: string): Promise<string> {
    return hashPassword(password);
  }

  verify(hash: string, password: string): Promise<boolean> {
    return verifyPassword(hash, password);
  }

  async dummyVerify(password: string): Promise<void> {
    this.dummy ??= hashPassword(randomBytes(24).toString('base64'));
    await verifyPassword(await this.dummy, password);
  }
}

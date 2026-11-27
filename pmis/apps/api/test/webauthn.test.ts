import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { authenticationOptions, finishAuthentication, finishRegistration, registrationOptions, type RpConfig } from '../src/security/webauthn';

/** Vector tests for the thin WebAuthn module, with a software authenticator built here (ES256, attestation none). */
const rp: RpConfig = { rpId: 'pmis.example.test', rpName: 'PMIS', origins: ['https://pmis.example.test'] };
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest();

// minimal CBOR writer for the few shapes needed
function cbor(v: unknown): Buffer {
  const head = (m: number, n: number) => n < 24 ? Buffer.from([(m << 5) | n]) : n < 256 ? Buffer.from([(m << 5) | 24, n]) : Buffer.from([(m << 5) | 25, n >> 8, n & 255]);
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') { const b = Buffer.from(v); return Buffer.concat([head(3, b.length), b]); }
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error('cbor');
}

function authenticator() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credId = randomBytes(16);
  const cose = cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, 'base64url')], [-3, Buffer.from(jwk.y!, 'base64url')]]));
  const flags = (uv: boolean) => 0x01 | (uv ? 0x04 : 0);
  const authData = (rpId: string, counter: number, uv: boolean, withCred: boolean) => {
    const c = Buffer.alloc(4); c.writeUInt32BE(counter);
    const base = Buffer.concat([sha(rpId), Buffer.from([flags(uv) | (withCred ? 0x40 : 0)]), c]);
    if (!withCred) return base;
    const l = Buffer.alloc(2); l.writeUInt16BE(credId.length);
    return Buffer.concat([base, Buffer.alloc(16), l, credId, cose]);
  };
  const clientData = (type: string, challenge: string, origin: string) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  return {
    id: credId.toString('base64url'),
    register(challenge: string, o: { origin?: string; rpId?: string; uv?: boolean } = {}) {
      const ad = authData(o.rpId ?? rp.rpId, 0, o.uv ?? true, true);
      const att = cbor(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', ad]]));
      return { id: credId.toString('base64url'), rawId: credId.toString('base64url'), type: 'public-key', response: { clientDataJSON: clientData('webauthn.create', challenge, o.origin ?? rp.origins[0]!).toString('base64url'), attestationObject: att.toString('base64url'), transports: ['internal'] }, clientExtensionResults: {} };
    },
    assert(challenge: string, counter: number, o: { origin?: string; uv?: boolean } = {}) {
      const ad = authData(rp.rpId, counter, o.uv ?? true, false);
      const cd = clientData('webauthn.get', challenge, o.origin ?? rp.origins[0]!);
      const sig = createSign('SHA256').update(Buffer.concat([ad, sha(cd)])).sign(privateKey);
      return { id: credId.toString('base64url'), rawId: credId.toString('base64url'), type: 'public-key', response: { clientDataJSON: cd.toString('base64url'), authenticatorData: ad.toString('base64url'), signature: sig.toString('base64url') }, clientExtensionResults: {} };
    },
  };
}

describe('webauthn module', () => {
  it('registers a passkey, then signs in with it and moves the counter forward', async () => {
    const a = authenticator();
    const ro = await registrationOptions(rp, { id: 'u1', name: 'a@x.test', displayName: 'A' }, []);
    expect(ro.authenticatorSelection?.userVerification).toBe('required');
    expect(ro.attestation).toBe('none');
    const np = await finishRegistration(rp, a.register(ro.challenge), ro.challenge);
    expect(np?.credentialId).toBe(a.id);
    const ao = await authenticationOptions(rp, [a.id]);
    const stored = { credentialId: a.id, publicKey: np!.publicKey, signCount: np!.signCount };
    const ok = await finishAuthentication(rp, a.assert(ao.challenge, 5), ao.challenge, stored);
    expect(ok?.newCounter).toBe(5);
  });
  it('rejects a wrong challenge, a wrong origin, a wrong rpId and a missing user verification at registration', async () => {
    const a = authenticator();
    const ro = await registrationOptions(rp, { id: 'u1', name: 'a@x.test', displayName: 'A' }, []);
    expect(await finishRegistration(rp, a.register(ro.challenge), 'another-challenge')).toBeNull();
    expect(await finishRegistration(rp, a.register(ro.challenge, { origin: 'https://evil.test' }), ro.challenge)).toBeNull();
    expect(await finishRegistration(rp, a.register(ro.challenge, { rpId: 'evil.test' }), ro.challenge)).toBeNull();
    expect(await finishRegistration(rp, a.register(ro.challenge, { uv: false }), ro.challenge)).toBeNull();
    expect(await finishRegistration(rp, { junk: true }, ro.challenge)).toBeNull();
  });
  it('rejects a replayed or rolled-back counter, a wrong challenge, a wrong origin, a bad signature and another account key', async () => {
    const a = authenticator(), b = authenticator();
    const ro = await registrationOptions(rp, { id: 'u1', name: 'a@x.test', displayName: 'A' }, []);
    const np = (await finishRegistration(rp, a.register(ro.challenge), ro.challenge))!;
    const ao = await authenticationOptions(rp, [a.id]);
    const stored = { credentialId: a.id, publicKey: np.publicKey, signCount: 7 };
    expect(await finishAuthentication(rp, a.assert(ao.challenge, 7), ao.challenge, stored)).toBeNull();
    expect(await finishAuthentication(rp, a.assert(ao.challenge, 3), ao.challenge, stored)).toBeNull();
    expect(await finishAuthentication(rp, a.assert(ao.challenge, 8), 'nope', stored)).toBeNull();
    expect(await finishAuthentication(rp, a.assert(ao.challenge, 8, { origin: 'https://evil.test' }), ao.challenge, stored)).toBeNull();
    expect(await finishAuthentication(rp, a.assert(ao.challenge, 8, { uv: false }), ao.challenge, stored)).toBeNull();
    expect(await finishAuthentication(rp, b.assert(ao.challenge, 8), ao.challenge, stored)).toBeNull();
    expect((await finishAuthentication(rp, a.assert(ao.challenge, 8), ao.challenge, stored))?.newCounter).toBe(8);
  });
});

import { describe, expect, it } from 'vitest';
import { authenticator as makeAuthenticator } from './webauthn-authenticator';
import { authenticationOptions, finishAuthentication, finishRegistration, registrationOptions, type RpConfig } from '../src/security/webauthn';

/** Vector tests for the thin WebAuthn module, with a software authenticator built here (ES256, attestation none). */
const rp: RpConfig = { rpId: 'pmis.example.test', rpName: 'PMIS', origins: ['https://pmis.example.test'] };
const authenticator = () => makeAuthenticator(rp);
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

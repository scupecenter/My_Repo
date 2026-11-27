import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';

/**
 * The one place the WebAuthn library (@simplewebauthn/server, pinned) is used (S4, passkeys). Everything else talks to these four functions, so the library can be swapped
 * without touching the services. Rules fixed here: attestation is not requested (we only need the public key), user verification is required, only ES256 and RS256.
 */
const ALGS = [-7, -257];
export const CHALLENGE_BYTES = 32;

export interface RpConfig { rpId: string; rpName: string; origins: string[] }
export interface StoredPasskey { credentialId: string; publicKey: Uint8Array; signCount: number; transports?: string[] }
export interface NewPasskey { credentialId: string; publicKey: Uint8Array; signCount: number; transports: string[]; backedUp: boolean; deviceType: string }

const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');

/** Options for the browser to create a passkey. `excludeIds` stops the same authenticator being added twice. */
export async function registrationOptions(rp: RpConfig, user: { id: string; name: string; displayName: string }, excludeIds: string[]) {
  return generateRegistrationOptions({
    rpName: rp.rpName, rpID: rp.rpId, userName: user.name, userDisplayName: user.displayName,
    userID: new TextEncoder().encode(user.id), attestationType: 'none', supportedAlgorithmIDs: ALGS,
    excludeCredentials: excludeIds.map((id) => ({ id })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
  });
}

/** Returns the new credential, or null when anything does not verify (origin, rpId, challenge, flags, algorithm). Never throws on a bad response. */
export async function finishRegistration(rp: RpConfig, response: unknown, expectedChallenge: string): Promise<NewPasskey | null> {
  try {
    const v = await verifyRegistrationResponse({
      response: response as Parameters<typeof verifyRegistrationResponse>[0]['response'], expectedChallenge, expectedOrigin: rp.origins, expectedRPID: rp.rpId,
      requireUserPresence: true, requireUserVerification: true, supportedAlgorithmIDs: ALGS,
    });
    if (!v.verified) return null;
    const c = v.registrationInfo.credential;
    return { credentialId: c.id, publicKey: c.publicKey, signCount: c.counter, transports: (c.transports ?? []) as string[], backedUp: v.registrationInfo.credentialBackedUp, deviceType: v.registrationInfo.credentialDeviceType };
  } catch { return null; }
}

export async function authenticationOptions(rp: RpConfig, allow: string[]) {
  return generateAuthenticationOptions({ rpID: rp.rpId, userVerification: 'required', allowCredentials: allow.map((id) => ({ id })) });
}

/** Returns the new sign counter, or null when it does not verify. A counter that did not move forward (when either side is non-zero) is a clone signal and fails. */
export async function finishAuthentication(rp: RpConfig, response: unknown, expectedChallenge: string, stored: StoredPasskey): Promise<{ newCounter: number } | null> {
  try {
    const v = await verifyAuthenticationResponse({
      response: response as Parameters<typeof verifyAuthenticationResponse>[0]['response'], expectedChallenge, expectedOrigin: rp.origins, expectedRPID: rp.rpId,
      credential: { id: stored.credentialId, publicKey: stored.publicKey as Uint8Array<ArrayBuffer>, counter: stored.signCount, transports: stored.transports as never },
      requireUserVerification: true,
    });
    return v.verified ? { newCounter: v.authenticationInfo.newCounter } : null;
  } catch { return null; }
}

export const publicKeyToText = (k: Uint8Array) => b64u(k);
export const publicKeyFromText = (s: string) => new Uint8Array(Buffer.from(s, 'base64url'));

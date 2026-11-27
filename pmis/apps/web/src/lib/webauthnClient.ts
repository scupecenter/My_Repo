/**
 * Browser side of WebAuthn (0.15.194, passkeys). The one place that touches navigator.credentials, so the rest of the screens never do.
 * The server sends the options as JSON with base64url binary fields and takes the result back as JSON in the same shape; this module converts both ways.
 * No dependency: the three conversions below are all the protocol needs on this side.
 */
const toBuf = (s: string): ArrayBuffer => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
};
export const toB64u = (b: ArrayBuffer | ArrayBufferView): string => {
  const u = b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  let bin = '';
  for (const x of u) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

type Opts = Record<string, unknown>;
type Desc = { id: string; type?: string; transports?: string[] };
const descs = (l: unknown): PublicKeyCredentialDescriptor[] => (Array.isArray(l) ? (l as Desc[]).map((d) => ({ ...d, type: 'public-key' as const, id: toBuf(d.id), transports: d.transports as AuthenticatorTransport[] | undefined })) : []);

export const passkeysSupported = (): boolean => typeof window !== 'undefined' && !!window.PublicKeyCredential && !!navigator.credentials;

/** True when the person cancelled the browser prompt (not an error worth showing). */
export const wasCancelled = (e: unknown): boolean => e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'AbortError');

/** Make a passkey from the server's registration options; returns the JSON the server verifies. */
export async function createPasskey(options: Opts): Promise<Record<string, unknown>> {
  const o = options as { challenge: string; user: { id: string; name: string; displayName: string } };
  const cred = (await navigator.credentials.create({
    publicKey: { ...(options as object), challenge: toBuf(o.challenge), user: { ...o.user, id: toBuf(o.user.id) }, excludeCredentials: descs(options.excludeCredentials) } as PublicKeyCredentialCreationOptions,
  })) as PublicKeyCredential | null;
  if (!cred) throw new DOMException('No credential', 'NotAllowedError');
  const r = cred.response as AuthenticatorAttestationResponse;
  return {
    id: cred.id, rawId: toB64u(cred.rawId), type: cred.type, clientExtensionResults: cred.getClientExtensionResults(), authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    response: { clientDataJSON: toB64u(r.clientDataJSON), attestationObject: toB64u(r.attestationObject), transports: r.getTransports?.() ?? [] },
  };
}

/** Answer the server's sign-in challenge with a passkey; returns the JSON the server verifies. */
export async function getPasskeyAssertion(options: Opts): Promise<Record<string, unknown>> {
  const o = options as { challenge: string };
  const cred = (await navigator.credentials.get({
    publicKey: { ...(options as object), challenge: toBuf(o.challenge), allowCredentials: descs(options.allowCredentials) } as PublicKeyCredentialRequestOptions,
  })) as PublicKeyCredential | null;
  if (!cred) throw new DOMException('No credential', 'NotAllowedError');
  const r = cred.response as AuthenticatorAssertionResponse;
  return {
    id: cred.id, rawId: toB64u(cred.rawId), type: cred.type, clientExtensionResults: cred.getClientExtensionResults(), authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    response: { clientDataJSON: toB64u(r.clientDataJSON), authenticatorData: toB64u(r.authenticatorData), signature: toB64u(r.signature), userHandle: r.userHandle ? toB64u(r.userHandle) : undefined },
  };
}

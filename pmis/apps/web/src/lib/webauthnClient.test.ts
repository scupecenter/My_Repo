import { describe, expect, it } from 'vitest';
import { toB64u } from './webauthnClient';

describe('webauthnClient', () => {
  it('encodes bytes as unpadded base64url', () => {
    expect(toB64u(new Uint8Array([251, 255, 254]).buffer)).toBe('-__-');
    expect(toB64u(new Uint8Array([1, 2]))).toBe('AQI');
    expect(toB64u(new Uint8Array([]).buffer)).toBe('');
  });
});

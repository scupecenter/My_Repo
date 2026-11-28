import { describe, expect, it } from 'vitest';
import { anchorFromKey, anchorFromPoint } from './floatingPanel';

describe('floating panel corners', () => {
  it('a drop snaps to the nearest corner, mirrored in RTL', () => {
    expect(anchorFromPoint(900, 100, 1000, 800, false)).toBe('end-top');
    expect(anchorFromPoint(900, 700, 1000, 800, false)).toBe('end-bottom');
    expect(anchorFromPoint(100, 100, 1000, 800, false)).toBe('start-top');
    expect(anchorFromPoint(900, 100, 1000, 800, true)).toBe('start-top');
  });
  it('arrow keys move between corners; other keys do nothing', () => {
    expect(anchorFromKey('ArrowLeft', 'end-top', false)).toBe('start-top');
    expect(anchorFromKey('ArrowLeft', 'end-top', true)).toBe('end-top');
    expect(anchorFromKey('ArrowRight', 'start-top', true)).toBe('start-top');
    expect(anchorFromKey('ArrowDown', 'end-top', false)).toBe('end-bottom');
    expect(anchorFromKey('a', 'end-top', false)).toBeNull();
  });
});

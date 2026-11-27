/** Generated avatars (interface features, item 15): a stable colour and the initials of a name. No image is stored or fetched. */
export type AvatarStyle = 'initials' | 'gradient' | 'geometric' | 'none';
export type AvatarShape = 'circle' | 'rounded';
export type AvatarPalette = 'brand' | 'varied';

/** The first letter of the first two words (Arabic and Latin), upper-cased for Latin; a name with no letters gives "?". */
export function initialsOf(name: string | null | undefined): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  const letters = words.map((w) => Array.from(w).find((c) => /\p{L}|\p{N}/u.test(c)) ?? '').filter(Boolean);
  if (letters.length === 0) return '?';
  const two = letters.length === 1 ? Array.from(words[0] ?? '').filter((c) => /\p{L}|\p{N}/u.test(c)).slice(0, 2) : letters.slice(0, 2);
  return two.join('').toLocaleUpperCase();
}

/** A stable 32-bit hash of a text (FNV-1a), so the same person always gets the same colour. */
export function hashOf(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

/** Twelve hues kept apart; with 38 to 42 percent lightness white text keeps a contrast above 4.5. */
const HUES = [212, 256, 288, 330, 352, 14, 28, 150, 172, 190, 232, 96] as const;

export interface AvatarLook { background: string; shapeIndex: number; hue: number }

export function avatarLook(seed: string, style: AvatarStyle, palette: AvatarPalette): AvatarLook {
  const h = hashOf(seed);
  const hue = HUES[h % HUES.length] as number;
  const shapeIndex = (h >>> 8) % 4;
  if (palette === 'brand') return { background: 'var(--accent)', shapeIndex, hue };
  if (style === 'gradient') return { background: `linear-gradient(135deg, hsl(${hue} 62% 44%), hsl(${(hue + 38) % 360} 66% 36%))`, shapeIndex, hue };
  return { background: `hsl(${hue} 55% 38%)`, shapeIndex, hue };
}

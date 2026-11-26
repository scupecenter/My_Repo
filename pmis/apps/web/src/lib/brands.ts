/**
 * Switchable UI designs (owner decision 2026-11-19, migration 0130, contract 0.15.41). The tokens live in styles/tokens.css (`[data-brand=...]` blocks);
 * `current` is today's look and the default. The design is independent of the light/dark theme (users.theme) and never changes the status colours.
 */
export const BRANDS = ['current', 'aljeel', 'executive', 'field', 'obsidian', 'sahara'] as const;
export type Brand = (typeof BRANDS)[number];

export const isBrand = (b: unknown): b is Brand => typeof b === 'string' && (BRANDS as readonly string[]).includes(b);

/** Sets data-brand on <html> (no attribute for `current`, so the base tokens apply exactly as before) and remembers it for the next load. */
export function applyBrand(b: Brand | null | undefined): void {
  const v: Brand = isBrand(b) ? b : 'current';
  try { localStorage.setItem('pmis.brand', v); } catch { /* storage blocked: the attribute still applies */ }
  if (v === 'current') document.documentElement.removeAttribute('data-brand');
  else document.documentElement.setAttribute('data-brand', v);
}

/** The design used before /me answers (the last one seen on this browser), so a reload does not flash the default. */
export function savedBrand(): Brand {
  try { const v = localStorage.getItem('pmis.brand'); return isBrand(v) ? v : 'current'; } catch { return 'current'; }
}

/**
 * Swatches of each design in the light theme, for the previews on Settings > Identity & themes and in My profile. They are the values of tokens.css
 * (contrast.test.ts checks that they match), written out so a preview shows its own design whatever design the page itself uses.
 */
export interface BrandSwatch { side: string; sideInk: string; sideMute: string; sideSel: string; sideActive: string; sideMark: string; accent: string; accentInk: string; accentSoft: string; accentText: string; bg: string; card: string; line: string; ink: string; mute: string }
export const BRAND_SWATCHES: Record<Brand, BrandSwatch> = {
  current: {
    side: 'oklch(0.979 0 0)', sideInk: 'oklch(0.205 0 0)', sideMute: 'oklch(0.439 0 0)', sideSel: 'oklch(0.946 0 0)', sideActive: 'oklch(0.205 0 0)', sideMark: 'oklch(0.502 0.084 186.188)',
    accent: 'oklch(0.502 0.084 186.188)', accentInk: 'oklch(1 0 0)', accentSoft: 'oklch(0.963 0.018 184.27)', accentText: 'oklch(0.431 0.069 188.078)',
    bg: 'oklch(0.979 0 0)', card: 'oklch(1 0 0)', line: 'oklch(0.913 0 0)', ink: 'oklch(0.205 0 0)', mute: 'oklch(0.439 0 0)',
  },
  aljeel: {
    side: '#0F2557', sideInk: '#DCE3F3', sideMute: '#AAB9DD', sideSel: '#1E3A7B', sideActive: '#FFFFFF', sideMark: '#F26A21',
    accent: '#1D4AB8', accentInk: '#FFFFFF', accentSoft: '#E8EEFB', accentText: '#17337A',
    bg: 'oklch(0.979 0 0)', card: 'oklch(1 0 0)', line: 'oklch(0.913 0 0)', ink: 'oklch(0.205 0 0)', mute: 'oklch(0.439 0 0)',
  },
  executive: {
    side: '#FFFFFF', sideInk: '#2A3547', sideMute: '#556070', sideSel: '#EAF0FD', sideActive: '#17337A', sideMark: '#1D4AB8',
    accent: '#1D4AB8', accentInk: '#FFFFFF', accentSoft: '#EAF0FD', accentText: '#17337A',
    bg: '#F7F8FA', card: 'oklch(1 0 0)', line: 'oklch(0.913 0 0)', ink: 'oklch(0.205 0 0)', mute: 'oklch(0.439 0 0)',
  },
  field: {
    side: '#0B1220', sideInk: '#FFFFFF', sideMute: '#C3CCD9', sideSel: '#24324F', sideActive: '#FFFFFF', sideMark: '#FB923C',
    accent: '#C2410C', accentInk: '#FFFFFF', accentSoft: '#FDE7DA', accentText: '#7C2D12',
    bg: 'oklch(0.979 0 0)', card: 'oklch(1 0 0)', line: '#AEB8C2', ink: 'oklch(0.205 0 0)', mute: '#3A4651',
  },
  obsidian: {
    side: '#0E1116', sideInk: '#ECEFF4', sideMute: '#A7B0BE', sideSel: '#222833', sideActive: '#F2C14E', sideMark: '#E0A82E',
    accent: '#8A5A00', accentInk: '#FFFFFF', accentSoft: '#FBF1DC', accentText: '#6B4500',
    bg: '#F4F5F7', card: 'oklch(1 0 0)', line: 'oklch(0.913 0 0)', ink: 'oklch(0.205 0 0)', mute: 'oklch(0.439 0 0)',
  },
  sahara: {
    side: '#123D2E', sideInk: '#E3F0EA', sideMute: '#A9C8BA', sideSel: '#216049', sideActive: '#FFFFFF', sideMark: '#E8C26A',
    accent: '#0B6B4F', accentInk: '#FFFFFF', accentSoft: '#E3F2EB', accentText: '#0A4F3A',
    bg: '#FAF7F2', card: 'oklch(1 0 0)', line: 'oklch(0.913 0 0)', ink: 'oklch(0.205 0 0)', mute: 'oklch(0.439 0 0)',
  },
};

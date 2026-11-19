import { readFileSync } from 'node:fs';
import { resolve as path } from 'node:path';
import { BRAND_SWATCHES, BRANDS, type Brand } from '@/lib/brands';

// Read as text: vitest returns an empty string for CSS imports.
const raw = readFileSync(path(process.cwd(), 'src/styles/tokens.css'), 'utf8');

// WCAG AA contrast over the token pairs screens use, in both themes (plan 2.11 item 4), and for every UI design (0130) in both themes.
type Vars = Record<string, string>;
const block = (sel: string) => { const i = raw.indexOf(`${sel}{`); return i < 0 ? '' : raw.slice(i + sel.length + 1, raw.indexOf('\n}', i)); };
const decls = (b: string): Vars => Object.fromEntries([...b.matchAll(/(--[\w-]+):([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const light = decls(block(':root'));
const dark = { ...light, ...decls(block('[data-theme=dark]')) };

/** The tokens in force on <html> for a design and a theme, in the cascade order of tokens.css. */
function varsOf(brand: Brand, theme: 'light' | 'dark'): Vars {
  if (brand === 'current') return theme === 'light' ? light : dark;
  const common = decls(block(`[data-brand=${brand}]`));
  return theme === 'light'
    ? { ...light, ...decls(block(`[data-brand=${brand}]:not([data-theme=dark])`)), ...common }
    : { ...dark, ...decls(block(`[data-theme=dark][data-brand=${brand}]`)), ...common };
}

function resolve(v: Vars, name: string): string {
  let x = v[name];
  for (let i = 0; i < 10 && x?.startsWith('var('); i++) x = v[x.slice(4, -1)];
  return x;
}
const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
function toRgb(color: string): [number, number, number] {
  if (color.startsWith('#')) {
    const h = color.slice(1);
    return [0, 2, 4].map((i) => srgbToLinear(parseInt(h.slice(i, i + 2), 16) / 255)) as [number, number, number];
  }
  const [L, C, h] = color.match(/oklch\(([^)]+)\)/)![1].split('/')[0].trim().split(/\s+/).map(Number);
  const a = C * Math.cos((h * Math.PI) / 180), b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s]
    .map((c) => Math.min(1, Math.max(0, c))) as [number, number, number]; // linear sRGB
}
const lum = (c: [number, number, number]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
/** A transparent colour (the dark sidebar) shows the page behind it. */
const solid = (v: Vars, name: string) => { const c = resolve(v, name); return /\/\s*0\s*\)$/.test(c) ? resolve(v, '--bg') : c; };
function ratio(v: Vars, fg: string, bg: string) {
  const [a, b] = [lum(toRgb(solid(v, fg))), lum(toRgb(solid(v, bg)))];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const TEXT: [string, string][] = [
  ['--ink', '--bg'], ['--ink', '--card'], ['--mute', '--card'], ['--mute', '--bg'], ['--ink', '--hover'], ['--mute', '--hover'], ['--ink', '--sideOn'], ['--mute', '--card2'],
  ['--accentInk', '--accent'], ['--accentText', '--card'], ['--accentText', '--accentSoft'], ['--link', '--card'],
  ['--doneInk', '--doneBg'], ['--openInk', '--openBg'], ['--waitInk', '--waitBg'], ['--lateInk', '--lateBg'], ['--lateOn', '--late'], ['--lockInk', '--lockBg'],
  ...['done', 'progress', 'late', 'locked', 'na', 'planned'].map((s): [string, string] => [`--state-${s}-fg`, `--state-${s}-bg`]),
];
// The sidebar (0130): its text on its own background, on hover and on the active entry, and the search field.
const SIDE_TEXT: [string, string][] = [
  ['--sideInk', '--side'], ['--sideMute', '--side'], ['--sideInk', '--sideHover'], ['--sideMute', '--sideHover'], ['--sideActive', '--sideSel'], ['--sideOnInk', '--sideSel'],
  ['--sideOnInk', '--side'], ['--sideInk', '--sideField'], ['--accentInk', '--accent'],
];

describe.each([['light', light], ['dark', dark]] as const)('WCAG AA contrast, %s theme', (_n, vars) => {
  it.each(TEXT)('%s on %s is at least 4.5:1', (fg, bg) => {
    expect(ratio(vars, fg, bg)).toBeGreaterThanOrEqual(4.5);
  });
  it('the site map lights and the tower stand out from the land (3:1, non-text contrast)', () => {
    const marks = ['--map-tower', '--map-idle', '--map-hold', '--stream-design', '--stream-cw', '--stream-te', '--stream-closure', ...Array.from({ length: 10 }, (_, i) => `--ms-${i + 1}`)];
    for (const m of marks) expect(ratio(vars, m, '--map-land'), m).toBeGreaterThanOrEqual(3);
    expect(ratio(vars, '--map-land', '--map-sea'), 'land on sea').toBeGreaterThanOrEqual(1.05);
  });
  it('state borders differ from the card (1.3:1)', () => {
    for (const s of ['done', 'progress', 'late', 'locked', 'planned']) expect(ratio(vars, `--state-${s}-border`, '--card'), s).toBeGreaterThanOrEqual(1.3);
  });
});

const COMBOS = BRANDS.flatMap((b) => (['light', 'dark'] as const).map((t) => [b, t] as const));
describe.each(COMBOS)('UI design %s, %s theme (0130)', (brand, theme) => {
  const vars = varsOf(brand, theme);
  it.each([...TEXT, ...SIDE_TEXT])('%s on %s is at least 4.5:1', (fg, bg) => {
    expect(ratio(vars, fg, bg)).toBeGreaterThanOrEqual(4.5);
  });
  it('the sidebar icons and the active marker stand out (3:1, non-text contrast)', () => {
    expect(ratio(vars, '--sideFaint', '--side')).toBeGreaterThanOrEqual(3);
    expect(ratio(vars, '--sideMark', '--sideSel')).toBeGreaterThanOrEqual(brand === 'current' ? 1 : 3);
  });
});

describe('UI designs never touch the status colours (0130)', () => {
  const LOCKED = /^--(done|open|wait|late|lock)(Bg|Ink|On)?$|^--sideOn$|^--state-|^--(map|stream|ms)-|^--(surface|ink|outline)-/;
  it.each(BRANDS.filter((b) => b !== 'current'))('%s overrides layer-2 tokens only, never a status token', (brand) => {
    const keys = [`[data-brand=${brand}]:not([data-theme=dark])`, `[data-brand=${brand}]`, `[data-theme=dark][data-brand=${brand}]`].flatMap((s) => Object.keys(decls(block(s))));
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.filter((k) => LOCKED.test(k))).toEqual([]);
  });
  it('the current design has no override block (it is the look of the base tokens)', () => {
    expect(raw).not.toContain('[data-brand=current]');
  });
  it('the preview swatches are the light tokens of each design', () => {
    for (const b of BRANDS) {
      const v = varsOf(b, 'light');
      for (const [k, val] of Object.entries(BRAND_SWATCHES[b])) expect(val, `${b} ${k}`).toBe(resolve(v, `--${k}`));
    }
  });
});

it('design/tokens.css is a verbatim copy of the single token source', () => {
  expect(readFileSync(path(process.cwd(), '../../design/tokens.css'), 'utf8')).toBe(raw);
});

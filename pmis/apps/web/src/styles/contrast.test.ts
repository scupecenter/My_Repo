import { readFileSync } from 'node:fs';
import { resolve as path } from 'node:path';

// Read as text: vitest returns an empty string for CSS imports.
const raw = readFileSync(path(process.cwd(), 'src/styles/tokens.css'), 'utf8');

// WCAG AA contrast over the token pairs screens use, in both themes (plan 2.11 item 4).
type Vars = Record<string, string>;
const block = (sel: string) => { const i = raw.indexOf(`${sel}{`); return raw.slice(i + sel.length + 1, raw.indexOf('\n}', i)); };
const decls = (b: string): Vars => Object.fromEntries([...b.matchAll(/(--[\w-]+):([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const light = decls(block(':root'));
const dark = { ...light, ...decls(block('[data-theme=dark]')) };

function resolve(v: Vars, name: string): string {
  let x = v[name];
  for (let i = 0; i < 10 && x?.startsWith('var('); i++) x = v[x.slice(4, -1)];
  return x;
}
function toRgb(oklch: string): [number, number, number] {
  const [L, C, h] = oklch.match(/oklch\(([^)]+)\)/)![1].split('/')[0].trim().split(/\s+/).map(Number);
  const a = C * Math.cos((h * Math.PI) / 180), b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s]
    .map((c) => Math.min(1, Math.max(0, c))) as [number, number, number]; // linear sRGB
}
const lum = (c: [number, number, number]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
function ratio(v: Vars, fg: string, bg: string) {
  const [a, b] = [lum(toRgb(resolve(v, fg))), lum(toRgb(resolve(v, bg)))];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const TEXT: [string, string][] = [
  ['--ink', '--bg'], ['--ink', '--card'], ['--mute', '--card'], ['--mute', '--bg'], ['--ink', '--hover'], ['--ink', '--sideOn'], ['--mute', '--card2'],
  ['--accentInk', '--accent'], ['--accentText', '--card'], ['--accentText', '--accentSoft'], ['--link', '--card'],
  ['--doneInk', '--doneBg'], ['--openInk', '--openBg'], ['--waitInk', '--waitBg'], ['--lateInk', '--lateBg'], ['--lockInk', '--lockBg'],
  ...['done', 'progress', 'late', 'locked', 'na', 'planned'].map((s): [string, string] => [`--state-${s}-fg`, `--state-${s}-bg`]),
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

it('design/tokens.css is a verbatim copy of the single token source', () => {
  expect(readFileSync(path(process.cwd(), '../../design/tokens.css'), 'utf8')).toBe(raw);
});

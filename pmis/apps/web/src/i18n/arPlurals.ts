/**
 * Arabic has six plural categories (zero, one, two, few, many, other) but the catalogue writes only `_one` and `_other`. i18next then finds no
 * `_two`/`_few`/`_many`/`_zero` entry for a count such as 2 or 5 and falls back to the English text (visual review 2026-11-27, item 3: "reasons missing 2"
 * in the Arabic UI). Fill each missing category from `_other` so every count shows the Arabic text. An explicit category already written is kept.
 */
type Tree = { [k: string]: string | Tree };
const FILL = ['zero', 'two', 'few', 'many'] as const;

export function withArabicPlurals<T extends Tree>(tree: T): T {
  const out: Tree = {};
  for (const [k, v] of Object.entries(tree)) out[k] = typeof v === 'string' ? v : withArabicPlurals(v);
  for (const k of Object.keys(out)) {
    if (!k.endsWith('_other') || typeof out[k] !== 'string') continue;
    const base = k.slice(0, -'_other'.length);
    if (out[`${base}_one`] === undefined) continue; // a key that merely ends in _other (an enum value), not a plural pair
    for (const f of FILL) if (out[`${base}_${f}`] === undefined) out[`${base}_${f}`] = out[k];
  }
  return out as T;
}

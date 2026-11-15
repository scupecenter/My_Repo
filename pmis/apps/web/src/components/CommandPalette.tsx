import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useId, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { SEARCH_GROUP_ORDER, useGlobalSearch, useSiteIdLookup, type SearchHit } from '@/api/search';

const MAX_IDS = 500;
/** A Site ID token: letters or digits with - . _ / inside, and at least one digit. */
const SITE_ID_TOKEN = /^(?=.*\d)[A-Za-z0-9][A-Za-z0-9._/-]{1,39}$/;

/**
 * A paste of several Site IDs (new lines, commas or spaces): at least two tokens, every one shaped like an ID. Null for ordinary text,
 * so "Tripoli site" still searches. Duplicates (any case) are sent once; at most 500 are checked.
 */
export function siteIdTokens(text: string): string[] | null {
  const tokens = text.split(/[\s,;]+/).filter(Boolean);
  if (tokens.length < 2 || !tokens.every((t) => SITE_ID_TOKEN.test(t))) return null;
  const unique = tokens.filter((t, i) => tokens.findIndex((x) => x.toUpperCase() === t.toUpperCase()) === i);
  return unique.slice(0, MAX_IDS);
}

function useDebounced<T>(value: T, ms: number): T {
  const [shown, setShown] = useState(value);
  useEffect(() => {
    const handle = setTimeout(() => setShown(value), ms);
    return () => clearTimeout(handle);
  }, [value, ms]);
  return shown;
}

/** The title with the matched ranges marked (ranges come from the server, offsets into the raw title). */
function Highlighted({ text, ranges }: { text: string; ranges: [number, number][] }) {
  const parts: ReactNode[] = [];
  let pos = 0;
  ranges.forEach(([start, end], i) => {
    if (start < pos || end > text.length || start >= end) return;
    if (start > pos) parts.push(text.slice(pos, start));
    parts.push(<mark key={i} className="rounded-sm bg-accent/25 text-ink">{text.slice(start, end)}</mark>);
    pos = end;
  });
  if (pos < text.length) parts.push(text.slice(pos));
  return <>{parts}</>;
}

interface Option {
  testid: string;
  run: () => void;
  content: ReactNode;
}
interface Section {
  key: string;
  heading: ReactNode;
  options: Option[];
}

function hitOption(hit: SearchHit, type: string, go: (to: string) => void): Option {
  return {
    testid: `palette-hit-${type}-${hit.id}`,
    run: () => go(hit.href),
    content: (
      <span className="block">
        <span className="block"><Highlighted text={hit.title} ranges={hit.match_ranges} /></span>
        {hit.subtitle && <span className="block text-xs text-mute">{hit.subtitle}</span>}
      </span>
    ),
  };
}

export function CommandPalette({ open, onOpenChange, items }: { open: boolean; onOpenChange: (o: boolean) => void; items: { key: string; to: string }[] }) {
  const { t } = useTranslation();
  const nav = useNavigate();
  const listId = useId();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const term = q.trim();
  const ids = siteIdTokens(term);
  const debounced = useDebounced(term, 250);
  const search = useGlobalSearch(!ids && term.length >= 2 ? debounced : '');
  const lookup = useSiteIdLookup(ids ?? []);

  const go = (to: string) => {
    onOpenChange(false);
    setQ('');
    setActive(0);
    nav(to);
  };

  // The sections in screen order. The keyboard index runs over their options in the same order.
  const sections: Section[] = [];
  const found = lookup.data?.found ?? [];
  if (ids) {
    if (lookup.data) {
      const options: Option[] = [];
      if (found.length > 0) {
        options.push({
          testid: 'palette-site-list',
          run: () => go(`/sites?site_codes=${found.map((f) => encodeURIComponent(f.site_code)).join(',')}`),
          content: <span className="font-semibold">{t('palette.site_list_found', { count: found.length })} · {t('palette.site_list_open')}</span>,
        });
      }
      for (const f of found) options.push({ testid: `palette-site-${f.id}`, run: () => go(f.href), content: <span className="mono">{f.site_code}</span> });
      sections.push({ key: 'site-list', heading: t('palette.site_list'), options });
    }
  } else {
    const navOptions = items
      .filter((i) => t(`nav.${i.key}`).toLowerCase().includes(term.toLowerCase()))
      .map((i): Option => ({ testid: `palette-${i.key}`, run: () => go(i.to), content: t(`nav.${i.key}`) }));
    if (navOptions.length > 0) sections.push({ key: 'nav', heading: t('palette.nav'), options: navOptions });
    const groups = term.length >= 2 ? (search.data?.groups ?? []) : [];
    for (const type of SEARCH_GROUP_ORDER) {
      const group = groups.find((g) => g.type === type);
      if (!group || group.items.length === 0) continue;
      sections.push({
        key: type,
        heading: <>{t(`palette.group.${type}`)}{group.truncated ? ` (${group.total})` : ''}</>,
        options: group.items.map((h) => hitOption(h, type, go)),
      });
    }
  }
  const flat = sections.flatMap((s) => s.options);
  const cur = Math.min(active, Math.max(flat.length - 1, 0));

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(cur + 1, flat.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(cur - 1, 0)); }
    else if (e.key === 'Enter' && flat[cur]) { e.preventDefault(); flat[cur].run(); }
  };
  // A paste with line breaks would lose them in a one-line input: they become spaces, so a list of Site IDs stays a list.
  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text');
    if (!/[\r\n]/.test(text)) return;
    e.preventDefault();
    const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).join(' ');
    setQ((prev) => (prev.trim() ? `${prev.trim()} ${lines}` : lines));
    setActive(0);
  };

  const loading = (term.length >= 2 && !ids && search.isFetching) || (!!ids && lookup.isFetching);
  let offset = 0;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-scrim/60" />
        <Dialog.Content data-testid="palette" className="card fixed inset-x-0 top-24 z-50 mx-auto max-h-[70vh] w-[min(560px,92vw)] overflow-y-auto p-3">
          <Dialog.Title className="sr-only">{t('palette.title')}</Dialog.Title>
          <Dialog.Description className="sr-only">{t('palette.placeholder')}</Dialog.Description>
          <input autoFocus role="combobox" aria-expanded={flat.length > 0} aria-controls={listId} aria-autocomplete="list"
            aria-label={t('palette.placeholder')} aria-activedescendant={flat[cur] ? `${listId}-${cur}` : undefined}
            className="input" data-testid="palette-input" placeholder={t('palette.placeholder')} value={q}
            onChange={(e) => { setQ(e.target.value); setActive(0); }} onKeyDown={onKey} onPaste={onPaste} />
          {ids && ids.length >= MAX_IDS && <p className="mt-1 text-xs text-mute">{t('palette.too_many', { max: MAX_IDS })}</p>}
          <p role="status" aria-live="polite" className="mt-1 min-h-4 text-xs text-mute">
            {loading ? t('palette.searching') : search.isError && !ids ? t('palette.error') : ''}
          </p>
          <ul id={listId} role="listbox" aria-label={t('palette.title')} className="mt-1">
            {sections.map((s) => {
              const start = offset;
              offset += s.options.length;
              return (
                <li key={s.key} role="presentation">
                  <ul role="presentation">
                    <li role="presentation" className="px-2 pt-2 text-xs font-semibold text-mute" data-testid={`palette-section-${s.key}`}>{s.heading}</li>
                    {s.options.map((o, k) => {
                      const i = start + k;
                      return (
                        <li key={o.testid} role="presentation">
                          <button type="button" role="option" id={`${listId}-${i}`} aria-selected={i === cur} data-testid={o.testid}
                            className={`w-full rounded-md p-2 text-start hover:bg-hover ${i === cur ? 'bg-hover' : ''}`}
                            onMouseEnter={() => setActive(i)} onClick={o.run}>{o.content}</button>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              );
            })}
          </ul>
          {ids && lookup.data && lookup.data.not_found.length > 0 && (
            <p className="px-2 pt-2 text-sm" data-testid="palette-not-found">
              <span className="font-semibold">{t('palette.not_found', { count: lookup.data.not_found.length })}</span>{' '}
              <span className="mono">{lookup.data.not_found.join(', ')}</span>
            </p>
          )}
          {!loading && flat.length === 0 && term.length > 0 && <p className="p-2 text-mute">{t('palette.empty')}</p>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

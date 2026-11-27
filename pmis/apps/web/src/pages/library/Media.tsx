import { Download, ExternalLink, FileImage, FileText, Settings2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { downloadFile } from '@/api/client';
import { EMPTY_MEDIA_FILTER, mediaLinkTo, useMediaFacets, useMediaItems, useMediaThumb, type MediaFilter, type MediaItem } from '@/api/media';
import { PageHeader } from '@/components/PageHeader';
import { SavedViews } from '@/components/SavedViews';
import { EmptyState, QueryFallback } from '@/components/States';
import { SearchBox, TableToolbar } from '@/components/TableStandard';
import { Tip } from '@/components/Tip';
import { LibraryTabs } from './LibraryTabs';

const KEYS = Object.keys(EMPTY_MEDIA_FILTER) as (keyof MediaFilter)[];

function Card({ it, ar }: { it: MediaItem; ar: boolean }) {
  const { t } = useTranslation();
  const th = useMediaThumb(it, 'small');
  const to = mediaLinkTo(it.link as Record<string, unknown>);
  const typeName = (ar && it.type.name_ar) || it.type.name_en;
  const site = it.site as { code?: string } | null;
  const dl = () => void downloadFile(it.download_url).catch(() => undefined);
  return (
    <li className={`card overflow-hidden ${it.state === 'current' ? '' : 'opacity-70'}`} data-testid={`media-card-${it.id}`} data-kind={it.kind} data-state={it.state}>
      <div className="flex aspect-[4/3] items-center justify-center bg-card2">
        {th.data ? <img src={th.data} alt={typeName} loading="lazy" className="h-full w-full object-cover" data-testid="media-thumb" />
          : it.mime_type.startsWith('image/') ? <FileImage size={36} className="text-mute" aria-hidden /> : <FileText size={36} className="text-mute" aria-hidden />}
      </div>
      <div className="space-y-1 p-2 text-xs">
        <p className="truncate font-semibold" title={typeName}>{typeName}</p>
        <p className="flex flex-wrap items-center gap-1 text-mute">
          {site?.code && <span className="mono">{site.code}</span>}
          <span>{new Date(it.uploaded_at).toLocaleDateString(ar ? 'ar-LY' : 'en-GB')}</span>
          {it.state !== 'current' && <span className="chip bg-lockBg text-lockInk" data-testid="media-state">{t(`media.state_${it.state}`)}</span>}
        </p>
        <div className="flex items-center gap-1 pt-1">
          {to && <Tip text={t('media.open_record')}><Link to={to} className="btn px-2 py-1" aria-label={t('media.open_record')} data-testid="media-open"><ExternalLink size={14} aria-hidden /></Link></Tip>}
          <Tip text={t('media.download')}><button type="button" className="btn px-2 py-1" aria-label={t('media.download')} data-testid="media-download" onClick={dl}><Download size={14} aria-hidden /></button></Tip>
        </div>
      </div>
    </li>
  );
}

/** Library > Media (owner decisions GAL-1 and LIB-1): the images of every enabled source in one gallery, read live from the owning records. */
export function LibraryMedia() {
  const { t, i18n } = useTranslation();
  const ar = i18n.language === 'ar';
  const [sp, setSp] = useSearchParams();
  const f = Object.fromEntries(KEYS.map((k) => [k, sp.get(k) ?? ''])) as MediaFilter;
  const set = (p: Partial<MediaFilter>) => { const n = new URLSearchParams(sp); for (const [k, v] of Object.entries(p)) { if (v) n.set(k, v); else n.delete(k); } setSp(n, { replace: true }); };
  const q = useMediaItems(f), facets = useMediaFacets();
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const off = q.data?.pages[0] && !q.data.pages[0].enabled;
  const active = KEYS.filter((k) => f[k]).length;
  const sel = (k: keyof MediaFilter, label: string, opts: { v: string; l: string }[]) => (
    <label className="text-xs font-semibold text-mute">{label}
      <select className="input ms-1" data-testid={`media-f-${k}`} value={f[k]} onChange={(e) => set({ [k]: e.target.value })}>
        <option value="">{t('media.all')}</option>{opts.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
      </select>
    </label>);
  return (
    <div data-testid="page-library-media">
      <PageHeader title={t('media.title')} subtitle={t('media.sub')} context={<Tip text={t('media.settings_link')}><Link className="btn ms-auto px-2 py-1" to="/admin/settings/documents/media" aria-label={t('media.settings_link')} data-testid="media-settings-link"><Settings2 size={15} aria-hidden /></Link></Tip>} />
      <LibraryTabs />
      <TableToolbar testid="media-toolbar" kind="list"
        views={<SavedViews screen="library-media" value={f} empty={EMPTY_MEDIA_FILTER} onApply={(v) => { const x = v as Partial<MediaFilter>; set(Object.fromEntries(KEYS.map((k) => [k, String(x[k] ?? '')])) as Partial<MediaFilter>); }} />}
        search={<SearchBox testid="media-search" value={f.q} onChange={(v) => set({ q: v })} placeholder={t('media.search')} />}
        filter={<span className="flex flex-wrap items-center gap-2">
          {sel('source', t('media.f_source'), [{ v: 'documents', l: t('media.src_documents') }, { v: 'snags', l: t('media.src_snags') }])}
          {sel('doc_code', t('media.f_type'), (facets.data?.document_types ?? []).map((d) => ({ v: d.code, l: `${(ar && d.name_ar) || d.name_en} (${d.count})` })))}
          {sel('snag_type', t('media.f_snag_type'), (facets.data?.snag_types ?? []).map((d) => ({ v: d.code, l: (ar && d.name_ar) || d.name_en })))}
          {sel('status', t('media.f_status'), [{ v: 'pending_evidence', l: t('media.state_pending_evidence') }, { v: 'withdrawn', l: t('media.state_withdrawn') }])}
          <label className="text-xs font-semibold text-mute">{t('media.f_from')}<input type="date" className="input ms-1" data-testid="media-f-from" value={f.uploaded_from} onChange={(e) => set({ uploaded_from: e.target.value })} /></label>
          <label className="text-xs font-semibold text-mute">{t('media.f_to')}<input type="date" className="input ms-1" data-testid="media-f-to" value={f.uploaded_to} onChange={(e) => set({ uploaded_to: e.target.value })} /></label>
        </span>}
        count={<span className="text-sm text-mute" data-testid="media-count">{t('media.count', { count: items.length })}{active > 0 && <button type="button" className="btn ms-2 px-2 py-0.5 text-xs" data-testid="media-clear" onClick={() => setSp(new URLSearchParams(), { replace: true })}>{t('media.clear')}</button>}</span>} />
      {!q.data ? <QueryFallback queries={[q]} /> : off ? <EmptyState testid="media-off" title={t('media.off')} /> : !items.length ? <EmptyState testid="media-empty" title={t('media.empty')} /> : (
        <>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6" data-testid="media-grid">{items.map((it) => <Card key={`${it.kind}-${it.id}`} it={it} ar={ar} />)}</ul>
          {q.hasNextPage && <div className="mt-3 text-center"><button type="button" className="btn" data-testid="media-more" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>{t('media.more')}</button></div>}
        </>
      )}
    </div>
  );
}

import { Camera } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { dailyPlanPhotoTarget, statusPhotoTarget, useDailyPlanPhotos, useNewPhoto, useStatusPhotos, type ScreenPhotos, type SlotTarget } from '@/api/documents';
import { SlotList, uploadMessage } from './DocSlots';
import { useToast } from './Toast';

/**
 * The photo field of a screen (decision 32, 0473): the Daily Plan (one photo set per site and day) and Status Updates (per update, with a site of its region).
 * Same slots as every document: versions, withdraw (hidden, never deleted), audit, Media gallery. Shown only when its document type is on in
 * Settings > Documents; the minimum and the formats come from that type. A missing photo only informs, it blocks nothing.
 */
export function PhotoField({ data, target, sites, testid }: { data: ScreenPhotos | undefined; target: SlotTarget; sites: { id: string; label: string }[]; testid: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const add = useNewPhoto(target);
  const [site, setSite] = useState('');
  if (!data || !data.enabled) return null;
  const items = data.items;
  const label = (id: string) => sites.find((s) => s.id === id)?.label ?? '';
  const pick = site || sites[0]?.id || '';
  return (
    <section className="card space-y-2 p-3" aria-label={t('photoField.title')} data-testid={testid}>
      <h3 className="flex items-center gap-2 text-sm font-semibold"><Camera size={14} aria-hidden />{t('photoField.title')}</h3>
      {items.length === 0 && <p className="text-sm text-mute" data-testid={`${testid}-none`}>{t('photoField.none')}</p>}
      {sites.map((s) => {
        const mine = items.filter((i) => i.site_id === s.id);
        if (mine.length === 0) return null;
        return (
          <div key={s.id} data-testid={`${testid}-site-${s.id}`}>
            <p className="mono mb-1 text-sm font-semibold" dir="ltr">{s.label}</p>
            <SlotList slots={mine} target={target} edit={data.can_upload} />
          </div>
        );
      })}
      {data.can_upload && sites.length > 0 && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-sm font-semibold">{t('photoField.site')}
            <select className="input mt-1 w-auto font-normal" data-testid={`${testid}-site`} value={pick} onChange={(e) => setSite(e.target.value)}>
              {sites.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </label>
          <label className="btn cursor-pointer" data-testid={`${testid}-add`}>
            <Camera size={16} aria-hidden />{t('photoField.add')}
            <input type="file" accept="image/*" className="sr-only" data-testid={`${testid}-file`} aria-label={t('photoField.add')}
              onChange={(e) => {
                const file = e.target.files?.[0]; e.target.value = '';
                if (file && pick) add.mutate({ site_id: pick, file }, { onSuccess: () => toast(t('photoField.added', { site: label(pick) })), onError: (er) => toast(uploadMessage(t, er), 'err') });
              }} />
          </label>
        </div>
      )}
    </section>
  );
}

/** Option (a) of decision 32: a status update photo carries a site picked from the sites of the update's region (any visible site when the update has no region). */
function useRegionSites(region: number | null) {
  return useQuery({
    queryKey: ['photo-sites', region], staleTime: 60_000,
    queryFn: () => api.get<{ items: { id: string; site_code: string }[] }>('/sites', { query: { limit: 100, ...(region ? { region_id: region } : {}) } }).then((r) => r.items.map((s) => ({ id: s.id, label: s.site_code }))),
  });
}

export function StatusUpdatePhotos({ updateId, region }: { updateId: string; region: number | null }) {
  const q = useStatusPhotos(updateId);
  const sites = useRegionSites(region);
  return <PhotoField data={q.data} target={statusPhotoTarget(updateId)} sites={sites.data ?? []} testid={`status-photos-${updateId}`} />;
}

export function DailyPlanPhotos({ region, date, sites }: { region: number; date: string; sites: { id: string; label: string }[] }) {
  const q = useDailyPlanPhotos(region, date);
  return <PhotoField data={q.data} target={dailyPlanPhotoTarget(region, date)} sites={sites} testid={`daily-plan-photos-${region}`} />;
}

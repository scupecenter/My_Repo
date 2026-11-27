import { MapPin } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMe } from '@/api/hooks';
import { useProposeSiteChange } from '@/api/qc';
import { useSite } from '@/api/sites';
import { hasGrant, isAdmin } from '@/lib/perm';
import { useToast } from './Toast';

/**
 * A1: the selected acquisition candidate carries latitude and longitude. When the site has none, the panel offers to propose them; when the site has other values, it
 * shows both and asks before proposing the candidate's. The site identity is never written directly (technical decision Q473): this uses the same Change Control
 * proposal as Site identity (POST /sites/{id}/change-proposals, a reason, L2 approval), so no right is widened. The address has no identity field in that proposal,
 * so it is shown for reference only.
 */
export function AcquisitionSiteLocation({ siteId, data }: { siteId: string; data: Record<string, unknown> }) {
  const { t } = useTranslation();
  const toast = useToast();
  const me = useMe(true).data;
  const site = useSite(siteId);
  const propose = useProposeSiteChange(siteId);
  const [confirm, setConfirm] = useState(false);
  const lat = typeof data.latitude === 'number' ? data.latitude : null, lon = typeof data.longitude === 'number' ? data.longitude : null;
  const may = !!me && (isAdmin(me) || hasGrant(me, 'create') || hasGrant(me, 'edit'));
  if (data.selected !== 'Yes' || lat === null || lon === null || !may || !site.data) return null;
  const sLat = site.data.latitude ?? null, sLon = site.data.longitude ?? null;
  const empty = sLat === null && sLon === null;
  if (sLat === lat && sLon === lon) return null;
  const send = () => propose.mutate({ identity: { latitude: lat, longitude: lon }, reason: t('acqLocation.reason') }, {
    onSuccess: (r) => { setConfirm(false); toast(t('siteIdentity.proposed', { count: r.items.length, ids: r.items.map((i) => i.change_id).join(', ') })); },
    onError: () => setConfirm(false),
  });
  return (
    <section className="space-y-2 rounded-md border border-line p-3 text-sm" data-testid="acq-location" aria-label={t('acqLocation.title')}>
      <h3 className="flex items-center gap-2 font-semibold"><MapPin size={14} aria-hidden />{t('acqLocation.title')}</h3>
      <p dir="ltr" className="mono" data-testid="acq-location-cand">{t('acqLocation.candidate')}: {lat}, {lon}{typeof data.address === 'string' && data.address ? ` (${data.address})` : ''}</p>
      {!empty && <p dir="ltr" className="mono text-mute" data-testid="acq-location-site">{t('acqLocation.site')}: {String(sLat)}, {String(sLon)}</p>}
      {propose.isError && <p role="alert" className="text-lateInk" data-testid="acq-location-error">{t('acqLocation.failed')}</p>}
      {empty || confirm ? (
        <div className="space-y-2">
          {confirm && <p className="text-waitInk" data-testid="acq-location-confirm">{t('acqLocation.confirm')}</p>}
          <div className="flex gap-2">
            {confirm && <button type="button" className="btn" data-testid="acq-location-cancel" onClick={() => setConfirm(false)}>{t('acqLocation.cancel')}</button>}
            <button type="button" className="btn btn-primary" data-testid="acq-location-send" disabled={propose.isPending} onClick={send}>{empty ? t('acqLocation.fill') : t('acqLocation.replace')}</button>
          </div>
        </div>
      ) : <button type="button" className="btn" data-testid="acq-location-ask" onClick={() => setConfirm(true)}>{t('acqLocation.differs')}</button>}
      <p className="text-xs text-mute">{t('acqLocation.note')}</p>
    </section>
  );
}

import * as Dialog from '@radix-ui/react-dialog';
import { Copy, Check, Printer, QrCode as QrIcon, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { QrCode } from '@/components/TwoFactor';
import { Tip } from '@/components/Tip';

export interface SiteQrSite { id: string; site_code: string; name: string; name_ar?: string | null }

/** The address a scan opens: the site page. A signed-out phone is sent to sign-in first and comes back to this page (?next=). */
export const siteLink = (siteId: string, origin = window.location.origin) => `${origin}/sites/${siteId}`;

/**
 * QR code per site (printable). One icon button on the site header opens a sheet with the code, the site code and names in both languages
 * and the address in words, ready to print and stick on the site cabinet or gate. Nothing is stored or sent: the code is drawn in the browser
 * and the address is the ordinary site page, so scanning gives exactly the rights the person already has (no new door).
 */
export function SiteQrButton({ site }: { site: SiteQrSite }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const url = siteLink(site.id);
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); setCopied(true); setFailed(false); } catch { setFailed(true); }
  };
  return (
    <Dialog.Root open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setCopied(false); setFailed(false); } }}>
      <Tip text={t('siteqr.button_hint')}>
        <Dialog.Trigger asChild>
          <button type="button" className="btn px-2" data-testid="site-qr-open" aria-label={t('siteqr.button_hint')}><QrIcon size={16} /></button>
        </Dialog.Trigger>
      </Tip>
      <Dialog.Portal>
        <Dialog.Overlay data-qr-overlay="" className="fixed inset-0 z-[80] bg-scrim/60" />
        <Dialog.Content data-testid="site-qr-dialog" aria-describedby={undefined} className="card fixed inset-x-0 top-[6vh] z-[80] mx-auto w-[min(640px,94vw)] space-y-3 p-5">
          <div className="flex items-start gap-2">
            <Dialog.Title className="flex-1 text-lg font-bold">{t('siteqr.title', { code: site.site_code })}</Dialog.Title>
            <Tip text={t('siteqr.close')}><Dialog.Close asChild><button type="button" className="btn px-2" aria-label={t('siteqr.close')} data-testid="site-qr-close"><X size={16} /></button></Dialog.Close></Tip>
          </div>
          <p className="text-sm text-mute">{t('siteqr.note')}</p>
          <div data-qr-sheet="" data-testid="site-qr-sheet" className="flex flex-wrap items-center justify-center gap-6 rounded-md border border-line bg-white p-5 text-black">
            <QrCode value={url} label={t('siteqr.qr_label', { code: site.site_code })} />
            <div className="min-w-0 max-w-[22rem] space-y-1">
              <div className="mono text-3xl font-bold" dir="ltr" data-testid="site-qr-code">{site.site_code}</div>
              <div className="text-xl font-semibold"><bdi>{site.name}</bdi></div>
              {site.name_ar && <div className="text-xl" dir="rtl" lang="ar"><bdi>{site.name_ar}</bdi></div>}
              <div className="pt-2 text-sm">{t('siteqr.scan')}</div>
              <div className="break-all text-xs" dir="ltr" data-testid="site-qr-url">{url}</div>
            </div>
          </div>
          {failed && <p role="alert" className="text-sm text-lateInk">{t('siteqr.copy_failed')}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            <Tip text={t('siteqr.copy_hint')}><button type="button" className="btn" data-testid="site-qr-copy" onClick={() => void copy()}>{copied ? <Check size={16} /> : <Copy size={16} />}{copied ? t('siteqr.copied') : t('siteqr.copy')}</button></Tip>
            <Tip text={t('siteqr.print_hint')}><button type="button" className="btn btn-accent" data-testid="site-qr-print" onClick={() => window.print()}><Printer size={16} />{t('siteqr.print')}</button></Tip>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

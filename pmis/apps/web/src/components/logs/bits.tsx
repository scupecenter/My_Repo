import { Laptop, Smartphone, Tablet } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { DeviceInfo, LogActor } from '@/api/logs';
import { PersonTag } from '@/components/PersonTag';
import { Tip } from '@/components/Tip';

export const deviceText = (d?: DeviceInfo | null) => (d ? [d.browser, d.os, d.type].filter(Boolean).join(' · ') : '');

/** Device type as an icon; the tooltip (and the accessible name) carries browser, system and type. */
export function DeviceIcon({ device, testid }: { device?: DeviceInfo | null; testid?: string }) {
  if (!device) return <span className="text-mute">—</span>;
  const Icon = device.type === 'mobile' ? Smartphone : device.type === 'tablet' ? Tablet : Laptop;
  return (
    <Tip text={deviceText(device)}>
      <span tabIndex={0} role="img" aria-label={deviceText(device)} data-testid={testid} data-device={device.type} className="inline-flex"><Icon size={16} strokeWidth={1.75} aria-hidden /></span>
    </Tip>
  );
}

export function ViaChip({ via }: { via?: string | null }) {
  const { t } = useTranslation();
  if (!via) return <span className="text-mute">—</span>;
  return <span className="chip bg-card2" data-via={via}>{t(`logs.via_${via}`, { defaultValue: via })}</span>;
}

type PersonLike = LogActor | { id: string; display_name: string; employee_id?: string | null };
export const Who = ({ a }: { a?: PersonLike | null }) =>
  !a ? <span className="text-mute">—</span> : <PersonTag name={'name' in a ? a.name : a.display_name} employeeId={a.employee_id} />;

/** Readable text of a stored value. */
export const valueText = (v: unknown): string => (v === null || v === undefined || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

export const stamp = (iso?: string | null) => (iso ? new Date(iso).toISOString().replace('T', ' ').slice(0, 19) : '—');

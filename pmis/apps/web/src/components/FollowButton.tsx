import { Bell, BellRing } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFollows, useFollowToggle, type FollowTarget } from '@/api/x';
import { errText } from './FormDialog';
import { useToast } from './Toast';

/**
 * X2: follow a site or a register record. `entityId` is what the follow list carries: the site id, or the record's `entity_id` (shared by all its versions).
 * Following gives notifications only; it grants no access, and the server checks that the caller can read the item.
 */
export function FollowButton({ target, entityId }: { target: FollowTarget; entityId: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const follows = useFollows();
  const toggle = useFollowToggle();
  const on = !!follows.data?.some((f) => f.entity_id === entityId);
  const testid = target.kind === 'site' ? 'follow-site' : 'follow-record';
  const go = () => toggle.mutate({ target, follow: !on }, {
    onSuccess: () => toast(t(on ? 'follow.stopped' : 'follow.started')),
    onError: (e) => toast(errText(e, t), 'err'),
  });
  return (
    <button type="button" className={`btn ${on ? 'bg-accentSoft text-accentText' : ''}`} data-testid={testid} aria-pressed={on} disabled={follows.isLoading || toggle.isPending} title={t('follow.hint')} onClick={go}>
      {on ? <BellRing size={16} aria-hidden /> : <Bell size={16} aria-hidden />}{t(on ? 'follow.following' : 'follow.follow')}
    </button>
  );
}

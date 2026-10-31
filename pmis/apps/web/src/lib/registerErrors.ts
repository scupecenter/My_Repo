import type { TFunction } from 'i18next';
import { ApiError } from '@/api/client';
import { taskErrorMessage } from './taskErrors';
import { pathToField, type FieldIssue } from './registerForms';

/** Plain words for a refused register action: the task codes first (same sentences), then the register ones. '' = a cancelled step-up. */
export function registerErrorMessage(t: TFunction, e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 422 && e.code === 'validation_failed') return t('regErrors.fix_fields');
    if (e.status === 422 && e.code === 'template_rejected') return t(`regErrors.template_${String(e.problem.reason ?? 'unknown')}`, { defaultValue: t('regErrors.template_unknown') });
    if (e.status === 413) return t('regErrors.too_large');
    if (e.status === 404) return t('regErrors.not_found');
    if (e.code === 'duplicate') return t('regErrors.duplicate');
    if (e.code === 'freeze_active') return t('regErrors.freeze_active');
  }
  return taskErrorMessage(t, e);
}

/** Field problems of a 422, keyed by field code, to show under the inputs. */
export function serverFieldIssues(e: unknown): Record<string, FieldIssue> {
  if (!(e instanceof ApiError)) return {};
  return Object.fromEntries((e.problem.errors ?? []).map((x) => [pathToField(x.path), { code: x.code }]));
}

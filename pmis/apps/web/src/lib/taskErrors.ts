import type { TFunction } from 'i18next';
import { ApiError } from '@/api/client';

/** Problem fields that the contract sends next to `code`. */
type Extras = { missing?: unknown; claimed_by?: { display_name?: string } };

/** Codes that have their own sentence in `taskErrors.*`. */
export const TASK_ERROR_CODES = ['open_snags', 'mandatory_fields_missing', 'mandatory_slots_missing', 'note_required', 'already_claimed', 'not_eligible_holder', 'invalid_transition'] as const;

/**
 * Plain words for a refused task action. Returns '' for a step-up that the person cancelled (the dialog already said it).
 * The 422/409/403 codes of the workflow engine each have their own sentence; anything else falls back to the general ones.
 */
export function taskErrorMessage(t: TFunction, e: unknown): string {
  if (!(e instanceof ApiError)) return t('errors.generic');
  const x = e.problem as unknown as Extras;
  switch (e.code) {
    case 'mandatory_fields_missing':
    case 'mandatory_slots_missing': {
      const list = Array.isArray(x.missing) ? x.missing.filter((m): m is string => typeof m === 'string').join(', ') : '';
      return list ? t(`taskErrors.${e.code}_list`, { list }) : t(`taskErrors.${e.code}`);
    }
    case 'already_claimed':
      return x.claimed_by?.display_name ? t('taskErrors.already_claimed_by', { name: x.claimed_by.display_name }) : t('taskErrors.already_claimed');
    case 'open_snags':
    case 'note_required':
    case 'not_eligible_holder':
    case 'invalid_transition':
    case 'duplicate':
      return t(`taskErrors.${e.code}`);
    case 'precondition_failed':
      return t('errors.precondition_failed');
    case 'step_up_required':
      return '';
    default:
      return e.status === 403 ? t('errors.forbidden') : t('errors.generic');
  }
}

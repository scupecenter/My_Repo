/**
 * D6 (contract 0.15.564): the missing photo evidence of a document slot, from the photo_rules of its type (min_count). Read only: it informs, nothing is blocked.
 * A photo counts when it is a current, not superseded, not withdrawn image file of the slot.
 */
export interface PhotoFileLike {
  mime_type: string | null;
  is_current: boolean;
  superseded_by: string | null;
}

/** min_count of the effective photo_rules, or null when the type asks for no minimum. */
export function photoMinCount(rules: unknown): number | null {
  if (typeof rules !== 'object' || rules === null) return null;
  const n = (rules as { min_count?: unknown }).min_count;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null;
}

export function countPhotos(files: PhotoFileLike[]): number {
  return files.filter((f) => f.is_current && !f.superseded_by && typeof f.mime_type === 'string' && f.mime_type.toLowerCase().startsWith('image/')).length;
}

/** How many photos are still missing (0 when the minimum is met), null when the slot has no photo minimum. */
export function photosMissing(rules: unknown, files: PhotoFileLike[]): number | null {
  const min = photoMinCount(rules);
  return min === null ? null : Math.max(0, min - countPhotos(files));
}

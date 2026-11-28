/**
 * Thumbnail maker of the Media gallery (owner decision GAL-1). `sharp` is loaded on first use, so a server where it cannot load still runs: the
 * gallery then shows type icons instead of thumbnails and says so in Settings (thumbnails_unavailable).
 */
export type ThumbFormat = 'webp' | 'jpeg';

/** Source formats the maker reads. Anything else (HEIC, PDF, ...) gets an icon card, never a failed request. */
export const THUMB_SOURCE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/tiff', 'image/avif'] as const;
export const isThumbSource = (mime: string): boolean => (THUMB_SOURCE_MIMES as readonly string[]).includes(mime.toLowerCase());

type SharpFn = (typeof import('sharp'))['default'];
let sharpMod: Promise<SharpFn | null> | null = null;

export function loadSharp(): Promise<SharpFn | null> {
  sharpMod ??= import('sharp').then((m) => m.default).catch(() => null);
  return sharpMod;
}

export const thumbMime = (f: ThumbFormat): string => (f === 'webp' ? 'image/webp' : 'image/jpeg');

/** A source smaller than this on either side is not worth a thumbnail (it would only be enlarged by the card): the gallery shows the type icon instead. */
export const MIN_THUMB_SOURCE_PX = 16;

/** A resized copy that fits in px x px (never enlarged), upright by its EXIF orientation, metadata stripped (no GPS leaves the original). */
export async function makeThumb(input: Buffer, px: number, format: ThumbFormat, quality: number): Promise<{ data: Buffer; width: number; height: number } | null> {
  const sharp = await loadSharp();
  if (!sharp) return null;
  const meta = await sharp(input, { failOn: 'none', limitInputPixels: 100_000_000 }).metadata();
  if (!meta.width || !meta.height || Math.min(meta.width, meta.height) < MIN_THUMB_SOURCE_PX) throw new Error('source_too_small');
  const img = sharp(input, { failOn: 'none', limitInputPixels: 100_000_000 }).rotate().resize(px, px, { fit: 'inside', withoutEnlargement: true });
  const out = format === 'webp' ? img.webp({ quality }) : img.jpeg({ quality, mozjpeg: true });
  const { data, info } = await out.toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** The key of a thumbnail: the key of its source with the first part `thumbs` and the size in the name. Derived data: it is never a source of truth. */
export function thumbKey(sourceKey: string, size: 'small' | 'medium', px: number, format: ThumbFormat): string | null {
  const parts = sourceKey.split('/');
  if (parts.length < 2) return null;
  parts[0] = 'thumbs';
  parts[parts.length - 1] = `${parts[parts.length - 1]}-${size === 'small' ? 's' : 'm'}${px}-${format}`;
  const key = parts.join('/');
  return /^[a-z0-9]+(\/[a-z0-9-]+)+$/.test(key) ? key : null;
}

/** Every thumbnail key a source can have under the current sizes (both formats, so a format switch leaves none behind). */
export function thumbKeysOf(sourceKey: string, th: { small_px: number; medium_px: number }): string[] {
  const out: string[] = [];
  for (const f of ['webp', 'jpeg'] as ThumbFormat[]) {
    for (const [size, px] of [['small', th.small_px], ['medium', th.medium_px]] as const) {
      const k = thumbKey(sourceKey, size, px, f);
      if (k) out.push(k);
    }
  }
  return out;
}

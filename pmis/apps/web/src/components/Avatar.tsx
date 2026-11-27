import { useUiFeatures, type UiFeatures } from '@/api/uiFeatures';
import { avatarLook, initialsOf, type AvatarShape, type AvatarStyle } from '@/lib/avatar';

const SIZES = { xs: 'h-5 w-5 text-[10px]', sm: 'h-6 w-6 text-xs', md: 'h-8 w-8 text-sm', lg: 'h-12 w-12 text-lg' } as const;
export type AvatarSize = keyof typeof SIZES;

/** The six small geometric marks of the "geometric" style, drawn over the colour; one per person, stable. */
function Mark({ index }: { index: number }) {
  const common = { fill: 'rgba(255,255,255,.16)' };
  return (
    <svg viewBox="0 0 32 32" aria-hidden className="pointer-events-none absolute inset-0 h-full w-full">
      {index === 0 && <circle cx="26" cy="6" r="11" {...common} />}
      {index === 1 && <rect x="-4" y="18" width="40" height="9" transform="rotate(-24 16 22)" {...common} />}
      {index === 2 && <polygon points="0,32 32,32 32,8" {...common} />}
      {index === 3 && <><circle cx="6" cy="26" r="9" {...common} /><circle cx="28" cy="8" r="5" {...common} /></>}
    </svg>
  );
}

/**
 * A generated avatar (item 15): initials on a stable colour, no image stored or fetched. Style, shape and palette come from Settings > Screens > Interface.
 * `lists` marks a use beside a name in a list or table: it follows the "in lists" switch and the "none" style hides it. Elsewhere (the top bar) a person
 * with style "none" still gets plain initials in the accent colour. Decorative: the name is always written next to it.
 */
export function Avatar({ name, size = 'sm', lists = false, config, className = '' }: { name: string | null | undefined; size?: AvatarSize; lists?: boolean; config?: UiFeatures['avatars']; className?: string }) {
  const saved = useUiFeatures().avatars;
  const ui = config ?? saved; // `config` draws an unsaved choice (the preview in Settings)
  const style: AvatarStyle = ui.style;
  if (lists && (!ui.in_lists || style === 'none')) return null;
  const look = avatarLook(name ?? '', style === 'none' ? 'initials' : style, style === 'none' ? 'brand' : ui.palette);
  const shape: AvatarShape = ui.shape;
  return (
    <span aria-hidden data-testid="avatar" data-style={style} data-shape={shape}
      className={`relative inline-grid shrink-0 select-none place-items-center overflow-hidden font-bold text-white ${shape === 'circle' ? 'rounded-full' : 'rounded-md'} ${SIZES[size]} ${className}`}
      style={{ background: look.background, ...(style === 'none' || ui.palette === 'brand' ? { color: 'var(--accentInk, #fff)' } : {}) }}>
      {style === 'geometric' && <Mark index={look.shapeIndex} />}
      <span className="relative leading-none">{initialsOf(name)}</span>
    </span>
  );
}

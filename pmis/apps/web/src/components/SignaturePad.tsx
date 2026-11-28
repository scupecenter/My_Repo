import { Eraser, Undo2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

type Pt = { x: number; y: number };

/**
 * A signature pad (touch, pen and mouse) on a canvas: clear, undo the last stroke, and the drawing as a small PNG data URL (width at most 600 px, white background).
 * The strokes are kept as points, so the pad redraws after a resize and never needs a library. `onChange(null)` while it is empty. Keyboard users sign by typing the
 * name instead (the form always asks for the signer name next to the pad).
 */
export function SignaturePad({ onChange, disabled, testid = 'sigpad' }: { onChange: (png: string | null) => void; disabled?: boolean; testid?: string }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLCanvasElement>(null);
  const strokes = useRef<Pt[][]>([]);
  const drawing = useRef(false);
  const [count, setCount] = useState(0);

  const paint = useCallback(() => {
    const c = ref.current; if (!c) return;
    const g = c.getContext('2d'); if (!g) return;
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.strokeStyle = '#111'; g.lineWidth = Math.max(2, c.width / 200); g.lineCap = 'round'; g.lineJoin = 'round';
    for (const s of strokes.current) {
      g.beginPath();
      s.forEach((p, i) => (i === 0 ? g.moveTo(p.x * c.width, p.y * c.height) : g.lineTo(p.x * c.width, p.y * c.height)));
      if (s.length === 1) g.lineTo(s[0]!.x * c.width + 0.1, s[0]!.y * c.height);
      g.stroke();
    }
  }, []);
  useEffect(() => { paint(); }, [paint]);

  const emit = useCallback(() => {
    setCount(strokes.current.length);
    const c = ref.current;
    if (!strokes.current.length || !c) return onChange(null);
    try { onChange(c.toDataURL('image/png')); } catch { onChange(null); }
  }, [onChange]);

  const at = (e: React.PointerEvent<HTMLCanvasElement>): Pt => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / (r.width || 1) || 0)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / (r.height || 1) || 0)) };
  };
  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (disabled) return;
    drawing.current = true; e.currentTarget.setPointerCapture?.(e.pointerId);
    strokes.current.push([at(e)]); paint();
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    strokes.current[strokes.current.length - 1]!.push(at(e)); paint();
  };
  const up = () => { if (drawing.current) { drawing.current = false; emit(); } };

  return (
    <div className="space-y-2" data-testid={testid}>
      <canvas ref={ref} width={600} height={220} role="img" aria-label={t('sigpad.label')} data-testid={`${testid}-canvas`} data-strokes={count}
        className="w-full touch-none rounded-md border border-line bg-white" style={{ aspectRatio: '600 / 220' }}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onPointerLeave={up} />
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn gap-1" disabled={disabled || !count} data-testid={`${testid}-undo`} aria-label={t('sigpad.undo')} onClick={() => { strokes.current.pop(); paint(); emit(); }}><Undo2 size={14} aria-hidden />{t('sigpad.undo')}</button>
        <button type="button" className="btn gap-1" disabled={disabled || !count} data-testid={`${testid}-clear`} aria-label={t('sigpad.clear')} onClick={() => { strokes.current = []; paint(); emit(); }}><Eraser size={14} aria-hidden />{t('sigpad.clear')}</button>
        <span className="text-xs text-mute">{count ? t('sigpad.strokes', { count }) : t('sigpad.hint')}</span>
      </div>
    </div>
  );
}

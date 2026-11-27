import { Circle, MoveUpRight, Trash2, Undo2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Draw arrows and circles on a photo before it uploads (item 14, Procore Quick Capture). The marks burn into a PNG copy; the original
 * file is untouched. No EXIF is kept on the copy, so the server treats it as any photo without EXIF (the unknown-capture-date flag, Q132).
 * Pointer Events only, no animation (reduced-motion safe); the same drag works with touch and mouse, in both directions (RTL included).
 */
type Shape = { kind: 'arrow' | 'circle'; x1: number; y1: number; x2: number; y2: number };
const RED = '#e11d48';

function drawShape(ctx: CanvasRenderingContext2D, s: Shape, w: number) {
  ctx.strokeStyle = RED;
  ctx.fillStyle = RED;
  ctx.lineWidth = Math.max(3, w / 160);
  ctx.lineCap = 'round';
  if (s.kind === 'circle') {
    ctx.beginPath();
    ctx.ellipse((s.x1 + s.x2) / 2, (s.y1 + s.y2) / 2, Math.abs(s.x2 - s.x1) / 2, Math.abs(s.y2 - s.y1) / 2, 0, 0, Math.PI * 2);
    ctx.stroke();
    return;
  }
  const head = ctx.lineWidth * 4;
  const ang = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
  ctx.beginPath();
  ctx.moveTo(s.x1, s.y1);
  ctx.lineTo(s.x2, s.y2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(s.x2, s.y2);
  ctx.lineTo(s.x2 - head * Math.cos(ang - Math.PI / 6), s.y2 - head * Math.sin(ang - Math.PI / 6));
  ctx.lineTo(s.x2 - head * Math.cos(ang + Math.PI / 6), s.y2 - head * Math.sin(ang + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
}

export function AnnotatePhoto({ file, onUse, onCancel, testid }: { file: File; onUse: (annotated: File) => void; onCancel: () => void; testid: string }) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [tool, setTool] = useState<'arrow' | 'circle'>('arrow');
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [draft, setDraft] = useState<Shape | null>(null);
  const [ready, setReady] = useState(false);
  const start = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { imgRef.current = img; setReady(true); };
    img.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    const c = canvasRef.current, img = imgRef.current;
    if (!c || !img || !ready) return;
    const maxW = Math.min(860, window.innerWidth - 48);
    const scale = Math.min(1, maxW / img.naturalWidth);
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(img, 0, 0, c.width, c.height);
    for (const s of [...shapes, ...(draft ? [draft] : [])]) drawShape(ctx, s, c.width);
  }, [ready, shapes, draft]);

  const point = (e: React.PointerEvent): { x: number; y: number } => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const down = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    start.current = point(e);
    setDraft(null);
  };
  const move = (e: React.PointerEvent) => {
    if (!start.current) return;
    const p = point(e);
    setDraft({ kind: tool, x1: start.current.x, y1: start.current.y, x2: p.x, y2: p.y });
  };
  const up = () => {
    if (draft && start.current) setShapes((ss) => [...ss, draft]);
    start.current = null;
    setDraft(null);
  };
  const use_ = () => {
    const c = canvasRef.current;
    if (!c) return;
    c.toBlob((b) => {
      if (b) onUse(new File([b], file.name.replace(/\.[a-z0-9]+$/i, '') + '-annotated.png', { type: 'image/png' }));
    }, 'image/png');
  };
  return (
    <div className="motion-panel card fixed inset-x-0 top-[4vh] z-[70] mx-auto max-h-[90vh] w-[min(920px,94vw)] space-y-3 overflow-y-auto p-4" role="dialog" aria-modal="true" data-testid={testid}>
      <div className="flex flex-wrap items-center gap-2">
        <b className="me-auto">{t('capture.annotate_title')}</b>
        <button type="button" className={`btn text-sm ${tool === 'arrow' ? 'btn-accent' : ''}`} data-testid={`${testid}-arrow`} onClick={() => setTool('arrow')}><MoveUpRight size={14} />{t('capture.arrow')}</button>
        <button type="button" className={`btn text-sm ${tool === 'circle' ? 'btn-accent' : ''}`} data-testid={`${testid}-circle`} onClick={() => setTool('circle')}><Circle size={14} />{t('capture.circle')}</button>
        <button type="button" className="btn text-sm" data-testid={`${testid}-undo`} disabled={!shapes.length} onClick={() => setShapes((ss) => ss.slice(0, -1))}><Undo2 size={14} />{t('capture.undo')}</button>
        <button type="button" className="btn text-sm" data-testid={`${testid}-clear`} disabled={!shapes.length} onClick={() => setShapes([])}><Trash2 size={14} />{t('capture.clear')}</button>
      </div>
      <canvas ref={canvasRef} className="mx-auto block max-w-full cursor-crosshair rounded border border-line" data-testid={`${testid}-canvas`}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { start.current = null; setDraft(null); }} />
      <div className="flex justify-end gap-2">
        <button type="button" className="btn" data-testid={`${testid}-cancel`} onClick={onCancel}>{t('common.cancel')}</button>
        <button type="button" className="btn" data-testid={`${testid}-asis`} onClick={() => onUse(file)}>{t('capture.use_asis')}</button>
        <button type="button" className="btn btn-primary" data-testid={`${testid}-use`} disabled={!ready} onClick={use_}>{t('capture.use_annotated')}</button>
      </div>
    </div>
  );
}

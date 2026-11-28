import { Maximize2, ZoomIn, ZoomOut } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Tip } from './Tip';

/**
 * A 360 degree (equirectangular) image you can turn: drag, arrow keys, the wheel or the buttons to look around and zoom. It draws with WebGL and no library.
 * When the browser has no WebGL (or the image is not wider than tall), it shows the image in a row you scroll sideways, so the picture is never lost.
 */
const VERT = 'attribute vec2 p; varying vec2 v; void main(){ v = p; gl_Position = vec4(p, 0.0, 1.0); }';
const FRAG = `precision highp float; varying vec2 v; uniform sampler2D tex; uniform float yaw; uniform float pitch; uniform float fov; uniform float aspect;
void main(){
  float t = tan(fov * 0.5);
  vec3 d = normalize(vec3(v.x * t * aspect, v.y * t, 1.0));
  float cp = cos(pitch), sp = sin(pitch);
  d = vec3(d.x, d.y * cp - d.z * sp, d.y * sp + d.z * cp);
  float cy = cos(yaw), sy = sin(yaw);
  d = vec3(d.x * cy + d.z * sy, d.y, -d.x * sy + d.z * cy);
  float lon = atan(d.x, d.z);
  float lat = asin(clamp(d.y, -1.0, 1.0));
  gl_FragColor = texture2D(tex, vec2(fract(lon / 6.28318530718 + 0.5), 0.5 - lat / 3.14159265359));
}`;
const MIN_FOV = 0.35, MAX_FOV = 2.1;

export function PanoramaView({ src, label }: { src: string; label: string }) {
  const { t } = useTranslation();
  const canvas = useRef<HTMLCanvasElement>(null);
  const view = useRef({ yaw: 0, pitch: 0, fov: 1.5 });
  const draw = useRef<() => void>(() => undefined);
  const [flat, setFlat] = useState(false);
  const bump = useCallback((dyaw: number, dpitch: number, dfov: number) => {
    const v = view.current;
    v.yaw += dyaw; v.pitch = Math.max(-1.5, Math.min(1.5, v.pitch + dpitch)); v.fov = Math.max(MIN_FOV, Math.min(MAX_FOV, v.fov + dfov));
    draw.current();
  }, []);

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const gl = el.getContext('webgl', { antialias: false, preserveDrawingBuffer: true }) as WebGLRenderingContext | null;
    if (!gl) { setFlat(true); return; }
    let dead = false;
    const img = new Image();
    img.onload = () => {
      if (dead) return;
      const max = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE) as number, 8192);
      let source: TexImageSource = img;
      if (img.naturalWidth > max) {
        const c = document.createElement('canvas');
        c.width = max; c.height = Math.max(1, Math.round((img.naturalHeight * max) / img.naturalWidth));
        c.getContext('2d')?.drawImage(img, 0, 0, c.width, c.height);
        source = c;
      }
      const mk = (type: number, code: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, code); gl.compileShader(s); return s; };
      const prog = gl.createProgram()!;
      gl.attachShader(prog, mk(gl.VERTEX_SHADER, VERT)); gl.attachShader(prog, mk(gl.FRAGMENT_SHADER, FRAG)); gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { setFlat(true); return; }
      gl.useProgram(prog);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, 'p');
      gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const u = (n: string) => gl.getUniformLocation(prog, n);
      draw.current = () => {
        const w = el.clientWidth || 640, h = el.clientHeight || 360;
        if (el.width !== w || el.height !== h) { el.width = w; el.height = h; }
        gl.viewport(0, 0, w, h);
        const v = view.current;
        gl.uniform1f(u('yaw'), v.yaw); gl.uniform1f(u('pitch'), v.pitch); gl.uniform1f(u('fov'), v.fov); gl.uniform1f(u('aspect'), w / h);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      };
      draw.current();
    };
    img.onerror = () => { if (!dead) setFlat(true); };
    img.src = src;
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => draw.current());
    ro?.observe(el);
    return () => { dead = true; ro?.disconnect(); draw.current = () => undefined; };
  }, [src]);

  const drag = useRef<{ x: number; y: number } | null>(null);
  if (flat) {
    return (
      <div className="h-full w-full overflow-x-auto overflow-y-hidden bg-card2" data-testid="pano-flat" tabIndex={0} aria-label={label}>
        <img src={src} alt={label} className="h-full max-w-none" draggable={false} />
      </div>
    );
  }
  return (
    <div className="relative h-full w-full bg-black" data-testid="pano-view">
      <canvas ref={canvas} role="img" aria-label={label} tabIndex={0} className="h-full w-full cursor-grab touch-none active:cursor-grabbing" data-testid="pano-canvas"
        onPointerDown={(e) => { drag.current = { x: e.clientX, y: e.clientY }; e.currentTarget.setPointerCapture(e.pointerId); }}
        onPointerMove={(e) => { const d = drag.current; if (!d) return; const k = view.current.fov / (e.currentTarget.clientHeight || 360); bump(-(e.clientX - d.x) * k, (e.clientY - d.y) * k, 0); drag.current = { x: e.clientX, y: e.clientY }; }}
        onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
        onWheel={(e) => bump(0, 0, e.deltaY > 0 ? 0.1 : -0.1)}
        onKeyDown={(e) => {
          const step = view.current.fov * 0.12;
          const m: Record<string, [number, number, number]> = { ArrowLeft: [-step, 0, 0], ArrowRight: [step, 0, 0], ArrowUp: [0, step, 0], ArrowDown: [0, -step, 0], '+': [0, 0, -0.1], '-': [0, 0, 0.1] };
          const a = m[e.key]; if (a) { e.preventDefault(); bump(...a); }
        }} />
      <div className="absolute bottom-2 end-2 flex gap-1">
        <Tip text={t('pano.zoom_in')}><button type="button" className="btn px-2 py-1" aria-label={t('pano.zoom_in')} data-testid="pano-zoom-in" onClick={() => bump(0, 0, -0.2)}><ZoomIn size={14} aria-hidden /></button></Tip>
        <Tip text={t('pano.zoom_out')}><button type="button" className="btn px-2 py-1" aria-label={t('pano.zoom_out')} data-testid="pano-zoom-out" onClick={() => bump(0, 0, 0.2)}><ZoomOut size={14} aria-hidden /></button></Tip>
        <Tip text={t('pano.reset')}><button type="button" className="btn px-2 py-1" aria-label={t('pano.reset')} data-testid="pano-reset" onClick={() => { view.current = { yaw: 0, pitch: 0, fov: 1.5 }; draw.current(); }}><Maximize2 size={14} aria-hidden /></button></Tip>
      </div>
      <p className="pointer-events-none absolute start-2 top-2 rounded bg-black/50 px-2 py-0.5 text-xs text-white">{t('pano.hint')}</p>
    </div>
  );
}

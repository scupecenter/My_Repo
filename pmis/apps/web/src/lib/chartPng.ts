/** Draws a chart host (an SVG or a canvas chart) to a PNG on a solid background, twice the screen size. Null when the browser cannot do it. */
export async function chartToPng(host: HTMLElement, bg: string, scale = 2): Promise<Blob | null> {
  const box = host.getBoundingClientRect();
  const w = Math.max(1, Math.round(box.width)), h = Math.max(1, Math.round(box.height));
  const out = document.createElement('canvas');
  out.width = w * scale; out.height = h * scale;
  const ctx = out.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = bg; ctx.fillRect(0, 0, out.width, out.height);
  const cv = host.querySelector('canvas');
  const svg = host.querySelector('svg');
  if (cv) ctx.drawImage(cv, 0, 0, out.width, out.height);
  else if (svg) {
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('width', String(w)); clone.setAttribute('height', String(h));
    const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(clone))}`;
    const img = new Image();
    const ok = await new Promise<boolean>((res) => { img.onload = () => res(true); img.onerror = () => res(false); img.src = url; });
    if (!ok) return null;
    ctx.drawImage(img, 0, 0, out.width, out.height);
  } else return null;
  return new Promise((res) => out.toBlob((b) => res(b), 'image/png'));
}

export const chartFileName = (label: string, now = new Date()): string =>
  `${label.normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'chart'}-${now.toISOString().slice(0, 10)}.png`;

export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

import { Square, Video } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * A short field video for a snag (item 14, Procore Quick Capture): the camera records in the browser (MediaRecorder, webm; mp4 where the
 * browser prefers it), a cap keeps the clip short, and the clip uploads through the snag photo path like any photo. Rendered only where the
 * snag type lists a video format; where the browser cannot record, the button stays but a click explains instead of failing silently.
 */
const CAP_SECONDS = 120;

export function RecordVideo({ formats, onFile, testid }: { formats: string[]; onFile: (f: File) => void; testid: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState(false);
  const [recording, setRecording] = useState(false);
  const [done, setDone] = useState<{ url: string; file: File } | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const allowed = formats.map((f) => f.toLowerCase());
  const wantsMp4 = allowed.includes('mp4') && !allowed.includes('webm');
  const mime = wantsMp4 ? 'video/mp4' : 'video/webm';

  const stopAll = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    streamRef.current?.getTracks().forEach((tr) => tr.stop());
    streamRef.current = null;
    recRef.current = null;
    setRecording(false);
  };
  useEffect(() => stopAll, []);
  if (!allowed.some((f) => ['webm', 'mp4', 'mov'].includes(f))) return null;

  const begin = async () => {
    setErr(false);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { setErr(true); setOpen(true); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: true });
      streamRef.current = stream;
      setOpen(true);
      requestAnimationFrame(() => { if (videoRef.current) { videoRef.current.srcObject = stream; void videoRef.current.play().catch(() => undefined); } });
    } catch {
      setErr(true);
      setOpen(true);
    }
  };
  const startRec = () => {
    const stream = streamRef.current;
    if (!stream) return;
    const type = MediaRecorder.isTypeSupported(mime) ? mime : '';
    const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      const actual = rec.mimeType || mime;
      const actualExt = actual.includes('mp4') ? 'mp4' : 'webm';
      const f = new File(chunks, `field-video.${actualExt}`, { type: actual });
      setDone({ url: URL.createObjectURL(f), file: f });
      stopAll();
    };
    recRef.current = rec;
    rec.start(250);
    setRecording(true);
    timerRef.current = setTimeout(() => rec.state !== 'inactive' && rec.stop(), CAP_SECONDS * 1000);
  };
  const stopRec = () => { const rec = recRef.current; if (rec && rec.state !== 'inactive') rec.stop(); };
  const close = () => { stopAll(); if (done) URL.revokeObjectURL(done.url); setDone(null); setOpen(false); setErr(false); };
  return (
    <>
      <button type="button" className="btn text-sm" data-testid={testid} onClick={begin}><Video size={14} />{t('capture.video')}</button>
      {open && (
        <div className="motion-panel card fixed inset-x-0 top-[6vh] z-[70] mx-auto max-h-[86vh] w-[min(640px,94vw)] space-y-3 overflow-y-auto p-4" role="dialog" aria-modal="true" data-testid={`${testid}-dialog`}>
          <b>{t('capture.video_title', { seconds: CAP_SECONDS })}</b>
          {err && <p role="alert" className="text-sm text-lateInk" data-testid={`${testid}-error`}>{t('capture.video_unsupported')}</p>}
          {!err && !done && <video ref={videoRef} className="w-full rounded border border-line" muted playsInline data-testid={`${testid}-live`} />}
          {done && <video src={done.url} className="w-full rounded border border-line" controls playsInline data-testid={`${testid}-preview`} />}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn" data-testid={`${testid}-cancel`} onClick={close}>{t('common.cancel')}</button>
            {!err && !done && !recording && <button type="button" className="btn btn-primary" data-testid={`${testid}-start`} onClick={startRec}><Video size={14} />{t('capture.record')}</button>}
            {recording && <button type="button" className="btn btn-danger" data-testid={`${testid}-stop`} onClick={stopRec}><Square size={14} />{t('capture.stop')}</button>}
            {done && <button type="button" className="btn btn-primary" data-testid={`${testid}-use`} onClick={() => { onFile(done.file); close(); }}>{t('capture.use_video')}</button>}
          </div>
        </div>
      )}
    </>
  );
}

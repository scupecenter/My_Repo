import { Mic, MicOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Voice dictation for a short field text (item 14 of the 2026-11-27 batch): the browser's speech recognition
 * appends to the field, in the page's language. Renders nothing where the browser has no speech recognition. No audio leaves the usual
 * browser service choice of the device; nothing is stored by this component.
 */
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
}
type SR = new () => SpeechRecognitionLike;
const engine = (): SR | null => {
  const w = window as unknown as { SpeechRecognition?: SR; webkitSpeechRecognition?: SR };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};

export function DictateButton({ onText, testid }: { onText: (text: string) => void; testid: string }) {
  const { t, i18n } = useTranslation();
  const [listening, setListening] = useState(false);
  const rec = useRef<SpeechRecognitionLike | null>(null);
  useEffect(() => () => { rec.current?.stop(); }, []);
  const Ctor = engine();
  if (!Ctor) return null;
  const toggle = () => {
    if (listening) { rec.current?.stop(); return; }
    const r = new Ctor();
    r.lang = i18n.language === 'ar' ? 'ar-SA' : 'en-US';
    r.interimResults = false;
    r.continuous = false;
    r.onresult = (e) => {
      const said = Array.from({ length: e.results.length }, (_, i) => e.results[i]?.[0]?.transcript ?? '').join(' ').trim();
      if (said) onText(said);
    };
    r.onend = () => setListening(false);
    r.onerror = () => setListening(false);
    rec.current = r;
    setListening(true);
    r.start();
  };
  return (
    <button type="button" className={`btn px-2 ${listening ? 'btn-accent' : ''}`} aria-label={t(listening ? 'capture.dictate_stop' : 'capture.dictate')}
      title={t(listening ? 'capture.dictate_stop' : 'capture.dictate')} data-testid={testid} data-listening={listening || undefined} onClick={toggle}>
      {listening ? <MicOff size={14} /> : <Mic size={14} />}
    </button>
  );
}

// All colours come from design/tokens.css variables (light + [data-theme=dark]).
const v = (n) => `var(--${n})`;
const STATES = ['done', 'progress', 'late', 'locked', 'na', 'planned'];
const stateColors = Object.fromEntries(STATES.flatMap((s) => ['fg', 'bg', 'border'].map((k) => [`state-${s}-${k}`, v(`state-${s}-${k}`)])));
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: v('bg'), card: v('card'), card2: v('card2'), hover: v('hover'), ink: v('ink'), mute: v('mute'), faint: v('faint'),
        line: v('line'), line2: v('line2'), side: v('side'), sideOn: v('sideOn'),
        accent: v('accent'), accentInk: v('accentInk'), accentSoft: v('accentSoft'), accentText: v('accentText'), link: v('link'),
        done: v('done'), doneBg: v('doneBg'), doneInk: v('doneInk'),
        open: v('open'), openBg: v('openBg'), openInk: v('openInk'),
        wait: v('wait'), waitBg: v('waitBg'), waitInk: v('waitInk'),
        late: v('late'), lateBg: v('lateBg'), lateInk: v('lateInk'),
        ...stateColors,
        lock: v('lock'), lockBg: v('lockBg'), lockInk: v('lockInk'), scrim: v('scrim'),
      },
      fontFamily: { sans: v('font') },
      borderRadius: { DEFAULT: v('radius-3'), md: v('radius-4'), lg: v('radius-6') },
      boxShadow: { sm: v('shadow-sm'), md: v('shadow-md'), lg: v('shadow-lg') },
    },
  },
};

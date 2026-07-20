export type GardenSoundCue =
  | 'plant'
  | 'sun'
  | 'wave'
  | 'hit'
  | 'seed-shot'
  | 'seed-hit'
  | 'frost-shot'
  | 'frost-hit'
  | 'ember-shot'
  | 'ember-hit'
  | 'chain-hit'
  | 'chrono-hit'
  | 'bite'
  | 'boss-hit'
  | 'mower'
  | 'win'
  | 'lose'
  | 'upgrade';

export interface GardenSoundOptions {
  pan?: number;
  intensity?: number;
}

type GardenNote = [frequency: number, offset: number, duration: number, type: OscillatorType, detune?: number];

interface GardenCueDefinition {
  notes: GardenNote[];
  volume: number;
  throttleMs: number;
  releaseMs: number;
}

let audioContext: AudioContext | null = null;
let activeCueCount = 0;
const lastCueAt = new Map<GardenSoundCue, number>();
const MAX_ACTIVE_CUES = 9;

function getAudioContext() {
  if (typeof window === 'undefined') return null;
  const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
  if (!AudioContextCtor) return null;
  if (!audioContext || audioContext.state === 'closed') audioContext = new AudioContextCtor();
  return audioContext;
}

export function unlockGardenSound(enabled = true) {
  if (!enabled) return;
  const context = getAudioContext();
  if (context?.state === 'suspended') void context.resume();
}

const CUES: Record<GardenSoundCue, GardenCueDefinition> = {
  plant: { notes: [[330, 0, 0.07, 'triangle'], [494, 0.07, 0.11, 'sine']], volume: 0.075, throttleMs: 80, releaseMs: 260 },
  sun: { notes: [[659, 0, 0.06, 'sine'], [988, 0.06, 0.12, 'triangle']], volume: 0.08, throttleMs: 55, releaseMs: 300 },
  wave: { notes: [[196, 0, 0.09, 'triangle'], [294, 0.11, 0.09, 'triangle'], [392, 0.23, 0.16, 'sine']], volume: 0.07, throttleMs: 450, releaseMs: 560 },
  hit: { notes: [[116, 0, 0.045, 'square']], volume: 0.032, throttleMs: 70, releaseMs: 150 },
  'seed-shot': { notes: [[294, 0, 0.035, 'triangle', -80], [390, 0.018, 0.03, 'sine']], volume: 0.032, throttleMs: 72, releaseMs: 130 },
  'seed-hit': { notes: [[122, 0, 0.04, 'square'], [184, 0.012, 0.028, 'triangle']], volume: 0.038, throttleMs: 66, releaseMs: 140 },
  'frost-shot': { notes: [[740, 0, 0.045, 'sine'], [990, 0.03, 0.05, 'triangle']], volume: 0.036, throttleMs: 95, releaseMs: 170 },
  'frost-hit': { notes: [[880, 0, 0.07, 'sine'], [1320, 0.035, 0.075, 'triangle', 40]], volume: 0.044, throttleMs: 90, releaseMs: 230 },
  'ember-shot': { notes: [[164, 0, 0.055, 'sawtooth'], [246, 0.025, 0.04, 'triangle']], volume: 0.038, throttleMs: 110, releaseMs: 180 },
  'ember-hit': { notes: [[82, 0, 0.12, 'sawtooth'], [130, 0.025, 0.1, 'square', -120]], volume: 0.058, throttleMs: 135, releaseMs: 300 },
  'chain-hit': { notes: [[196, 0, 0.05, 'sawtooth'], [740, 0.018, 0.065, 'square'], [1040, 0.065, 0.055, 'triangle']], volume: 0.048, throttleMs: 150, releaseMs: 260 },
  'chrono-hit': { notes: [[260, 0, 0.12, 'sine'], [520, 0.035, 0.14, 'triangle'], [780, 0.07, 0.12, 'sine']], volume: 0.045, throttleMs: 180, releaseMs: 320 },
  bite: { notes: [[92, 0, 0.055, 'square'], [72, 0.045, 0.07, 'triangle']], volume: 0.04, throttleMs: 125, releaseMs: 210 },
  'boss-hit': { notes: [[58, 0, 0.2, 'sawtooth'], [86, 0.05, 0.18, 'square'], [43, 0.12, 0.2, 'triangle']], volume: 0.065, throttleMs: 500, releaseMs: 480 },
  mower: { notes: [[92, 0, 0.18, 'sawtooth'], [147, 0.12, 0.2, 'square']], volume: 0.07, throttleMs: 700, releaseMs: 520 },
  win: { notes: [[392, 0, 0.12, 'triangle'], [523, 0.13, 0.12, 'sine'], [659, 0.27, 0.16, 'triangle'], [784, 0.46, 0.28, 'sine']], volume: 0.075, throttleMs: 900, releaseMs: 920 },
  lose: { notes: [[220, 0, 0.16, 'triangle'], [165, 0.17, 0.2, 'sine'], [110, 0.38, 0.34, 'triangle']], volume: 0.07, throttleMs: 900, releaseMs: 920 },
  upgrade: { notes: [[523, 0, 0.08, 'triangle'], [659, 0.09, 0.08, 'sine'], [988, 0.2, 0.18, 'triangle']], volume: 0.075, throttleMs: 180, releaseMs: 520 },
};

export function playGardenSound(cue: GardenSoundCue, enabled = true, options: GardenSoundOptions = {}) {
  if (!enabled || typeof document !== 'undefined' && document.hidden) return;
  const definition = CUES[cue];
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  if (now - (lastCueAt.get(cue) || -Infinity) < definition.throttleMs || activeCueCount >= MAX_ACTIVE_CUES) return;
  const context = getAudioContext();
  if (!context) return;
  if (context.state === 'suspended') void context.resume();
  lastCueAt.set(cue, now);
  activeCueCount += 1;

  const intensity = Math.max(0.55, Math.min(1.35, options.intensity ?? 1));
  const master = context.createGain();
  const startAt = context.currentTime;
  master.gain.setValueAtTime(0.0001, startAt);
  master.gain.exponentialRampToValueAtTime(definition.volume * intensity, startAt + 0.008);
  master.gain.exponentialRampToValueAtTime(0.0001, startAt + definition.releaseMs / 1000);

  let output: AudioNode = master;
  if (typeof context.createStereoPanner === 'function') {
    const panner = context.createStereoPanner();
    panner.pan.setValueAtTime(Math.max(-0.78, Math.min(0.78, options.pan ?? 0)), startAt);
    master.connect(panner);
    output = panner;
  }
  output.connect(context.destination);

  definition.notes.forEach(([frequency, offset, duration, type, detune = 0]) => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const noteStart = startAt + offset;
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, noteStart);
    oscillator.detune.setValueAtTime(detune, noteStart);
    gain.gain.setValueAtTime(0.0001, noteStart);
    gain.gain.exponentialRampToValueAtTime(0.76, noteStart + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, noteStart + duration);
    oscillator.connect(gain);
    gain.connect(master);
    oscillator.start(noteStart);
    oscillator.stop(noteStart + duration + 0.025);
  });

  window.setTimeout(() => {
    activeCueCount = Math.max(0, activeCueCount - 1);
    try { master.disconnect(); } catch { /* The context may have closed with the page. */ }
    if (output !== master) {
      try { output.disconnect(); } catch { /* The context may have closed with the page. */ }
    }
  }, definition.releaseMs + 120);
}

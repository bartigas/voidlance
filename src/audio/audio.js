// Void Lance — procedural audio. No dependencies, no binary assets, one AudioContext.
// Everything is synthesised from oscillators + two procedurally filled noise buffers.

const MAX_VOICES = 24; // one-shots in flight; extra requests are dropped, not queued
const LOOKAHEAD = 0.6; // seconds of music scheduled ahead of the audio clock
const TICK_MS = 120; // scheduler wake-up period; must stay well under LOOKAHEAD
const STALE_MS = 12000; // hard reap threshold (see reapStale)

const DEFAULTS = { master: 0.85, music: 0.5, sfx: 0.9 };

// Importing this module in Node (tests, SSR-ish tooling) must not explode.
const win = typeof window !== 'undefined' ? window : null;
const AudioCtor = win ? win.AudioContext || win.webkitAudioContext : null;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp01 = (v) => clamp(num(v, 0), 0, 1);
const noop = () => {};

const S = {
  ctx: null,
  available: Boolean(AudioCtor),
  muted: false,
  master: DEFAULTS.master,
  music: DEFAULTS.music,
  sfx: DEFAULTS.sfx,
  tension: 0,
  tensionShown: 0, // scheduler-smoothed value the pattern actually reads
  speed: 1,
  masterGain: null,
  limiter: null,
  sfxBus: null,
  musicBus: null,
  reverb: null,
  sfxSend: null,
  buffers: null,
  voices: new Set(),
  ambient: null,
  ambientWanted: false,
  musicTimer: 0,
  nextNoteTime: 0,
  step: 0,
  gestureOff: null,
  userSuspended: false, // distinguishes autoplay lock from an explicit suspend()
};

// ---------------------------------------------------------------- primitives

function safeDisconnect(node) {
  if (!node) return;
  try {
    node.disconnect();
  } catch {
    /* already detached */
  }
}

function ramp(param, value, tc = 0.08) {
  if (!param || !S.ctx) return;
  try {
    param.setTargetAtTime(value, S.ctx.currentTime, Math.max(0.005, tc));
  } catch {
    param.value = value;
  }
}

// White + pink-ish noise, generated once at init and reused by every burst.
function makeNoiseBuffers(ctx) {
  const len = Math.floor(ctx.sampleRate * 2);
  const white = ctx.createBuffer(1, len, ctx.sampleRate);
  const pink = ctx.createBuffer(1, len, ctx.sampleRate);
  const w = white.getChannelData(0);
  const p = pink.getChannelData(0);
  // Paul Kellet's economical pink filter: one pole per band, ~3dB/oct slope.
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < len; i++) {
    const x = Math.random() * 2 - 1;
    w[i] = x;
    b0 = 0.99886 * b0 + x * 0.0555179;
    b1 = 0.99332 * b1 + x * 0.0750759;
    b2 = 0.969 * b2 + x * 0.153852;
    b3 = 0.8665 * b3 + x * 0.3104856;
    b4 = 0.55 * b4 + x * 0.5329522;
    b5 = -0.7616 * b5 - x * 0.016898;
    p[i] = clamp((b0 + b1 + b2 + b3 + b4 + b5 + b6 + x * 0.5362) * 0.11, -1, 1);
    b6 = x * 0.115926;
  }
  return { white, pink };
}

// Feedback delay network reverb. Delay times are primes in ms so no two taps
// sit at a rational multiple of each other — that is what keeps the tail from
// turning into an obvious pitched comb tone. One lowpass per leg bleeds the
// highs off each repeat, which reads as room size instead of a slap-back.
function makeReverb(ctx) {
  const input = ctx.createGain();
  input.gain.value = 1;
  const sum = ctx.createGain();
  sum.gain.value = 1 / 8; // keeps the all-to-all loop gain below 1 (8 legs * 0.75 * 1/8)
  const pre = ctx.createDelay(0.05);
  pre.delayTime.value = 0.018;
  input.connect(pre);
  pre.connect(sum);
  const primes = [0.029, 0.041, 0.053, 0.071, 0.097, 0.127, 0.163, 0.199];
  const legs = primes.map((t) => {
    const d = ctx.createDelay(0.5);
    d.delayTime.value = t;
    const damp = ctx.createBiquadFilter();
    damp.type = 'lowpass';
    damp.frequency.value = 2600;
    damp.Q.value = 0.7;
    const fb = ctx.createGain();
    fb.gain.value = 0.75;
    sum.connect(d);
    d.connect(damp);
    damp.connect(fb);
    fb.connect(sum);
    return { d, damp, fb };
  });
  const out = ctx.createBiquadFilter();
  out.type = 'highpass';
  out.frequency.value = 140; // no sub energy in the tail, explosions stay clean
  const wet = ctx.createGain();
  wet.gain.value = 0.9;
  sum.connect(out);
  out.connect(wet);
  return { input, wet, nodes: [input, pre, sum, out, wet, ...legs.flatMap((l) => [l.d, l.damp, l.fb])] };
}

function buildGraph(ctx) {
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -6;
  limiter.knee.value = 3;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.004;
  limiter.release.value = 0.18;

  const masterGain = ctx.createGain();
  masterGain.gain.value = S.muted ? 0 : S.master;
  masterGain.connect(limiter);
  limiter.connect(ctx.destination);

  const sfxBus = ctx.createGain();
  sfxBus.gain.value = S.sfx;
  sfxBus.connect(masterGain);

  const musicBus = ctx.createGain();
  musicBus.gain.value = S.music;
  musicBus.connect(masterGain);

  const reverb = makeReverb(ctx);
  reverb.wet.connect(masterGain);

  // A flat send off the whole sfx bus gives every effect the same room; sounds
  // that want more space add their own per-layer send on top of this.
  const sfxSend = ctx.createGain();
  sfxSend.gain.value = 0.13;
  sfxBus.connect(sfxSend);
  sfxSend.connect(reverb.input);

  S.ctx = ctx;
  S.limiter = limiter;
  S.masterGain = masterGain;
  S.sfxBus = sfxBus;
  S.musicBus = musicBus;
  S.reverb = reverb;
  S.sfxSend = sfxSend;
  S.buffers = makeNoiseBuffers(ctx);
}

// ------------------------------------------------------------------- voices
// A voice is one play() call: a small channel strip (gain -> pan -> sfxBus,
// plus an optional send into the reverb) plus the bookkeeping that tears it
// down once every source node has fired `onended`.

function reapStale() {
  // `onended` never fires for a source whose context was suspended before it
  // reached its stop time. Reaping on the next allocation keeps the budget
  // honest without running a timer forever.
  const now = Date.now();
  for (const v of S.voices) {
    if (now - v.born > STALE_MS) closeVoice(v);
  }
}

function openVoice(opts) {
  if (!S.ctx) return null;
  if (S.voices.size >= MAX_VOICES) return null;
  reapStale();
  if (S.voices.size >= MAX_VOICES) return null;

  const input = S.ctx.createGain();
  input.gain.value = clamp(num(opts.gain, 1), 0, 4);
  const parts = [input];
  let tail = input;
  const pan = clamp(num(opts.pan, 0), -1, 1);
  if (pan !== 0 && typeof S.ctx.createStereoPanner === 'function') {
    const p = S.ctx.createStereoPanner();
    p.pan.value = pan;
    tail.connect(p);
    tail = p;
    parts.push(p);
  }
  tail.connect(S.sfxBus);

  const wet = clamp(num(opts.wet, 0), 0, 1);
  if (wet > 0 && S.reverb) {
    const send = S.ctx.createGain();
    send.gain.value = wet;
    tail.connect(send);
    send.connect(S.reverb.input);
    parts.push(send);
  }

  const voice = {
    in: input,
    parts,
    rate: clamp(num(opts.rate, 1), 0.25, 4),
    detune: clamp(num(opts.detune, 0), -2400, 2400),
    delay: clamp(num(opts.delay, 0), 0, 4),
    pending: 0,
    closed: false,
    born: Date.now(),
  };
  S.voices.add(voice);
  return voice;
}

function closeVoice(voice) {
  if (!voice || voice.closed) return;
  voice.closed = true;
  for (const n of voice.parts) safeDisconnect(n);
  voice.parts.length = 0;
  S.voices.delete(voice);
}

function expectEnd(voice, source) {
  voice.pending += 1;
  source.onended = () => {
    voice.pending -= 1;
    if (voice.pending <= 0) closeVoice(voice);
  };
}

function startAt(voice, extraDelay) {
  return S.ctx.currentTime + (voice ? voice.delay : 0) + num(extraDelay, 0);
}

// Shared AD envelope so no sound re-implements the same four lines.
function envelope(param, peak, attack, dur, curve, t0) {
  const a = clamp(num(attack, 0.004), 0.001, Math.max(0.001, dur * 0.5));
  const end = Math.max(a + 0.01, dur);
  const p = Math.max(0.0001, peak);
  param.cancelScheduledValues(t0);
  param.setValueAtTime(0.0001, t0);
  param.linearRampToValueAtTime(p, t0 + a);
  if (curve === 'lin') param.linearRampToValueAtTime(0.0001, t0 + end);
  else param.exponentialRampToValueAtTime(0.0001, t0 + end);
  param.setValueAtTime(0, t0 + end + 0.002);
  return t0 + end + 0.02;
}

function sweep(param, from, to, dur, t0, expo) {
  param.setValueAtTime(from, t0);
  if (to === null || to === undefined || to === from) return;
  if (expo) param.exponentialRampToValueAtTime(Math.max(0.0002, to), t0 + dur);
  else param.linearRampToValueAtTime(to, t0 + dur);
}

// One enveloped oscillator. `to` sweeps the pitch (portamento/gliss) over dur.
function tone({
  type = 'sine',
  freq = 440,
  to = null,
  dur = 0.2,
  gain = 0.25,
  pan = 0,
  attack = 0.004,
  curve = 'exp',
  delay = 0,
  wet = 0,
  detune = 0,
  voice = null,
} = {}) {
  if (!S.ctx) return null;
  const pitch = (voice ? voice.rate : 1) * Math.pow(2, ((voice ? voice.detune : 0) + detune) / 1200);
  const f0 = Math.max(10, num(freq, 440) * pitch);
  const f1 = to === null || to === undefined ? null : Math.max(10, num(to, f0) * pitch);
  const t0 = startAt(voice, delay);
  const d = Math.max(0.02, num(dur, 0.2));

  const osc = S.ctx.createOscillator();
  osc.type = type;
  osc.frequency.value = f0;
  sweep(osc.frequency, f0, f1, d, t0, true);

  const g = S.ctx.createGain();
  envelope(g.gain, num(gain, 0.25), attack, d, curve, t0);
  osc.connect(g);

  const parts = [osc, g];
  let out = g;
  if (pan !== 0 && typeof S.ctx.createStereoPanner === 'function' && !voice) {
    const p = S.ctx.createStereoPanner();
    p.pan.value = clamp(pan, -1, 1);
    out.connect(p);
    out = p;
    parts.push(p);
  }
  // Per-layer send rides on top of the bus-wide one, so a shield ping can be
  // drier than an explosion without touching the shared mix.
  if (wet > 0 && S.reverb) {
    const send = S.ctx.createGain();
    send.gain.value = clamp(wet, 0, 1);
    out.connect(send);
    send.connect(S.reverb.input);
    parts.push(send);
  }
  if (voice) {
    out.connect(voice.in);
    for (const p of parts) voice.parts.push(p);
    expectEnd(voice, osc);
  } else {
    out.connect(S.sfxBus);
    cleanupOnEnd(osc, parts);
  }
  osc.start(t0);
  osc.stop(t0 + d + 0.05);
  return osc;
}

// Filtered noise with an optional filter-frequency sweep. The workhorse for
// impacts, breath and thrusters.
function noiseBurst({
  dur = 0.25,
  gain = 0.2,
  pan = 0,
  attack = 0.003,
  curve = 'exp',
  delay = 0,
  wet = 0,
  noise = 'white',
  filter = 'lowpass',
  freq = 1200,
  to = null,
  q = 1,
  rate = 1,
  voice = null,
} = {}) {
  if (!S.ctx || !S.buffers) return null;
  const buffer = noise === 'pink' ? S.buffers.pink : S.buffers.white;
  const pitch = (voice ? voice.rate : 1) * rate;
  const f0 = Math.max(20, num(freq, 1200) * (voice ? voice.rate : 1));
  const f1 = to === null || to === undefined ? null : Math.max(20, num(to, f0) * (voice ? voice.rate : 1));
  const t0 = startAt(voice, delay);
  const d = Math.max(0.02, num(dur, 0.25));

  const src = S.ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = d > buffer.duration; // allow tails longer than the 2s asset
  src.playbackRate.value = clamp(pitch, 0.25, 4);

  const bq = S.ctx.createBiquadFilter();
  bq.type = filter;
  bq.frequency.value = f0;
  bq.Q.value = clamp(num(q, 1), 0.0001, 30);
  sweep(bq.frequency, f0, f1, d, t0, true);

  const g = S.ctx.createGain();
  envelope(g.gain, num(gain, 0.2), attack, d, curve, t0);
  src.connect(bq);
  bq.connect(g);

  const parts = [src, bq, g];
  let out = g;
  if (pan !== 0 && typeof S.ctx.createStereoPanner === 'function' && !voice) {
    const p = S.ctx.createStereoPanner();
    p.pan.value = clamp(pan, -1, 1);
    out.connect(p);
    out = p;
    parts.push(p);
  }
  if (wet > 0 && S.reverb) {
    const send = S.ctx.createGain();
    send.gain.value = clamp(wet, 0, 1);
    out.connect(send);
    send.connect(S.reverb.input);
    parts.push(send);
  }
  if (voice) {
    out.connect(voice.in);
    for (const p of parts) voice.parts.push(p);
    expectEnd(voice, src);
  } else {
    out.connect(S.sfxBus);
    cleanupOnEnd(src, parts);
  }
  src.start(t0);
  src.stop(t0 + d + 0.05);
  return src;
}

// Standalone cleanup for nodes outside the voice pool (music notes).
function cleanupOnEnd(source, parts) {
  source.onended = () => {
    for (const n of parts) safeDisconnect(n);
    parts.length = 0;
  };
}

// Stagger helper: `repeat(4, 0.07, (i, at) => ...)` for multi-hit weapons.
function repeat(count, step, fn) {
  for (let i = 0; i < count; i++) fn(i, i * step);
}

const rnd = (lo, hi) => lo + Math.random() * (hi - lo);

// ------------------------------------------------------------------- sounds
// Each sound is a handful of layers; every layer is one tone()/noiseBurst() call.

const SOUNDS = {
  uiHover(v) {
    tone({ type: 'sine', freq: 1180, to: 1460, dur: 0.05, gain: 0.06, attack: 0.004, voice: v });
  },

  uiClick(v) {
    tone({ type: 'square', freq: 920, to: 620, dur: 0.05, gain: 0.09, attack: 0.002, voice: v });
    noiseBurst({ dur: 0.04, gain: 0.1, filter: 'highpass', freq: 2600, q: 0.7, voice: v });
  },

  uiBack(v) {
    tone({ type: 'sawtooth', freq: 520, to: 268, dur: 0.14, gain: 0.07, attack: 0.004, voice: v });
    tone({ type: 'sine', freq: 260, to: 170, dur: 0.12, gain: 0.05, voice: v });
  },

  select(v) {
    tone({ type: 'sine', freq: 660, to: 990, dur: 0.12, gain: 0.11, attack: 0.003, voice: v });
    tone({ type: 'triangle', freq: 1320, to: 1980, dur: 0.09, gain: 0.04, voice: v });
    noiseBurst({ dur: 0.05, gain: 0.05, filter: 'bandpass', freq: 3400, q: 3, voice: v });
  },

  move(v) {
    noiseBurst({ noise: 'pink', dur: 0.34, gain: 0.1, filter: 'bandpass', freq: 520, to: 1500, q: 1.2, voice: v });
    tone({ type: 'sine', freq: 96, to: 72, dur: 0.3, gain: 0.09, voice: v });
  },

  thruster(v) {
    noiseBurst({ noise: 'pink', dur: 0.5, gain: 0.13, filter: 'bandpass', freq: 260, to: 1100, q: 0.9, attack: 0.06, curve: 'lin', voice: v });
    tone({ type: 'sine', freq: 64, to: 88, dur: 0.48, gain: 0.1, attack: 0.05, curve: 'lin', voice: v });
    noiseBurst({ dur: 0.16, gain: 0.05, filter: 'highpass', freq: 3000, attack: 0.02, curve: 'lin', voice: v });
  },

  // Rail spike: mechanical click, body thump, capacitor blip falling away.
  fireKinetic(v) {
    tone({ type: 'square', freq: 2100, to: 1500, dur: 0.02, gain: 0.11, attack: 0.001, voice: v });
    noiseBurst({ dur: 0.16, gain: 0.24, filter: 'bandpass', freq: 320, to: 110, q: 0.8, attack: 0.001, voice: v });
    tone({ type: 'sawtooth', freq: 300, to: 58, dur: 0.13, gain: 0.13, attack: 0.001, voice: v });
    noiseBurst({ dur: 0.07, gain: 0.08, filter: 'highpass', freq: 2200, voice: v, wet: 0 });
  },

  // Nova / pulse lance: saw swell up, inharmonic shimmer, reverb-heavy.
  fireEnergy(v) {
    tone({ type: 'sawtooth', freq: 130, to: 920, dur: 0.34, gain: 0.1, attack: 0.05, curve: 'lin', voice: v });
    tone({ type: 'sine', freq: 1860, to: 2790, dur: 0.3, gain: 0.05, attack: 0.06, voice: v });
    tone({ type: 'sine', freq: 2490, to: 3310, dur: 0.26, gain: 0.035, attack: 0.07, detune: 18, voice: v });
    noiseBurst({ dur: 0.4, gain: 0.07, filter: 'bandpass', freq: 900, to: 5200, q: 2.2, attack: 0.08, curve: 'lin', voice: v });
  },

  // Torpedo: valve breath plus a heavy mass starting to move.
  fireTorpedo(v) {
    noiseBurst({ noise: 'pink', dur: 0.55, gain: 0.18, filter: 'bandpass', freq: 1800, to: 300, q: 1.1, attack: 0.02, voice: v });
    tone({ type: 'sine', freq: 74, to: 44, dur: 0.55, gain: 0.16, attack: 0.03, curve: 'lin', voice: v });
    noiseBurst({ dur: 0.09, gain: 0.12, filter: 'lowpass', freq: 700, attack: 0.001, voice: v });
    tone({ type: 'triangle', freq: 180, to: 520, dur: 0.2, gain: 0.04, attack: 0.08, delay: 0.12, curve: 'lin', voice: v });
  },

  // Swarm launchers: pods leave the rack in sequence, then a shared plume.
  fireMissile(v) {
    repeat(4, 0.075, (i, at) => {
      noiseBurst({ dur: 0.09, gain: 0.16, filter: 'bandpass', freq: 1500 + i * 260, to: 420, q: 1.4, attack: 0.001, delay: at, voice: v });
      tone({ type: 'square', freq: 420 + i * 70, to: 150, dur: 0.06, gain: 0.06, attack: 0.001, delay: at, voice: v });
    });
    noiseBurst({ noise: 'pink', dur: 0.5, gain: 0.09, filter: 'lowpass', freq: 900, to: 320, attack: 0.1, curve: 'lin', delay: 0.1, voice: v });
  },

  // Deflector bloom: resonant inharmonic ping with a wobble on the tail.
  shieldHit(v) {
    tone({ type: 'sine', freq: 880, to: 790, dur: 0.5, gain: 0.13, attack: 0.002, voice: v });
    tone({ type: 'sine', freq: 1372, to: 1290, dur: 0.36, gain: 0.07, attack: 0.002, voice: v });
    tone({ type: 'sine', freq: 2267, dur: 0.22, gain: 0.035, attack: 0.002, voice: v });
    noiseBurst({ dur: 0.14, gain: 0.08, filter: 'bandpass', freq: 2600, q: 6, voice: v });
    wobble(v);
  },

  // Armour plate: dull thud with a short metallic rattle on top.
  armorHit(v) {
    tone({ type: 'sine', freq: 150, to: 58, dur: 0.26, gain: 0.22, attack: 0.002, voice: v });
    noiseBurst({ dur: 0.2, gain: 0.12, filter: 'lowpass', freq: 420, to: 180, q: 0.9, voice: v });
    repeat(3, 0.035, (i, at) => {
      noiseBurst({ dur: 0.06, gain: 0.07, filter: 'bandpass', freq: rnd(1800, 3600), q: 12, delay: at + 0.03, voice: v });
    });
  },

  // Hull: everything below 300Hz, no shimmer — it should feel like it hurt.
  hullHit(v) {
    tone({ type: 'sawtooth', freq: 92, to: 41, dur: 0.36, gain: 0.2, attack: 0.002, voice: v });
    noiseBurst({ dur: 0.34, gain: 0.2, filter: 'lowpass', freq: 300, to: 90, q: 1.3, voice: v });
    noiseBurst({ noise: 'pink', dur: 0.5, gain: 0.07, filter: 'lowpass', freq: 160, attack: 0.02, curve: 'lin', voice: v });
  },

  explodeSmall(v) {
    noiseBurst({ dur: 0.6, gain: 0.26, filter: 'lowpass', freq: 1900, to: 130, q: 0.8, attack: 0.002, voice: v });
    tone({ type: 'square', freq: 190, to: 42, dur: 0.28, gain: 0.09, attack: 0.001, voice: v });
    noiseBurst({ dur: 0.1, gain: 0.12, filter: 'highpass', freq: 2400, attack: 0.001, voice: v });
  },

  explodeLarge(v) {
    SOUNDS.explodeSmall(v);
    tone({ type: 'sine', freq: 96, to: 24, dur: 1.4, gain: 0.26, attack: 0.006, curve: 'lin', voice: v });
    noiseBurst({ noise: 'pink', dur: 1.5, gain: 0.15, filter: 'lowpass', freq: 900, to: 60, q: 0.7, attack: 0.01, curve: 'lin', delay: 0.05, voice: v });
    tone({ type: 'sawtooth', freq: 140, to: 30, dur: 0.7, gain: 0.08, attack: 0.004, voice: v });
  },

  shieldUp(v) {
    noiseBurst({ noise: 'pink', dur: 0.8, gain: 0.1, filter: 'bandpass', freq: 300, to: 3200, q: 1.6, attack: 0.25, curve: 'lin', voice: v });
    tone({ type: 'sine', freq: 330, to: 660, dur: 0.85, gain: 0.09, attack: 0.2, curve: 'lin', voice: v });
    tone({ type: 'sine', freq: 495, to: 990, dur: 0.75, gain: 0.05, attack: 0.3, curve: 'lin', voice: v });
    tone({ type: 'triangle', freq: 1320, dur: 0.3, gain: 0.04, attack: 0.05, delay: 0.7, voice: v });
  },

  repair(v) {
    repeat(3, 0.11, (i, at) => {
      tone({ type: 'sine', freq: [523, 659, 784][i], dur: 0.4, gain: 0.08, attack: 0.03, delay: at, voice: v });
      tone({ type: 'triangle', freq: [523, 659, 784][i] * 2, dur: 0.22, gain: 0.025, attack: 0.03, delay: at, voice: v });
    });
  },

  system(v) {
    tone({ type: 'triangle', freq: 440, dur: 0.3, gain: 0.1, attack: 0.006, voice: v });
    tone({ type: 'triangle', freq: 660, dur: 0.34, gain: 0.07, attack: 0.01, voice: v });
    tone({ type: 'sine', freq: 880, dur: 0.5, gain: 0.05, attack: 0.02, delay: 0.06, voice: v });
    noiseBurst({ dur: 0.08, gain: 0.05, filter: 'bandpass', freq: 4200, q: 4, voice: v });
  },

  // Denied action: two near-unison squares beat against each other.
  error(v) {
    tone({ type: 'square', freq: 208, to: 176, dur: 0.16, gain: 0.09, attack: 0.002, voice: v });
    tone({ type: 'square', freq: 196, to: 165, dur: 0.16, gain: 0.07, attack: 0.002, voice: v });
    noiseBurst({ dur: 0.05, gain: 0.06, filter: 'bandpass', freq: 900, q: 2, voice: v });
  },

  turnStart(v) {
    tone({ type: 'sine', freq: 587, dur: 0.8, gain: 0.1, attack: 0.006, voice: v });
    tone({ type: 'sine', freq: 880, dur: 0.55, gain: 0.05, attack: 0.008, voice: v });
    tone({ type: 'sine', freq: 1760, dur: 0.25, gain: 0.02, attack: 0.01, voice: v });
  },

  enemyTurn(v) {
    tone({ type: 'sine', freq: 294, dur: 0.9, gain: 0.11, attack: 0.02, voice: v });
    tone({ type: 'triangle', freq: 220, to: 208, dur: 0.85, gain: 0.07, attack: 0.05, curve: 'lin', voice: v });
    noiseBurst({ noise: 'pink', dur: 0.7, gain: 0.06, filter: 'lowpass', freq: 700, to: 220, attack: 0.2, curve: 'lin', voice: v });
  },

  victory(v) {
    const notes = [523, 659, 784, 1046];
    repeat(4, 0.17, (i, at) => {
      tone({ type: 'sine', freq: notes[i], dur: 0.7, gain: 0.11, attack: 0.006, delay: at, voice: v });
      tone({ type: 'triangle', freq: notes[i] * 2, dur: 0.3, gain: 0.03, attack: 0.008, delay: at, voice: v });
    });
    tone({ type: 'sine', freq: 131, dur: 1.2, gain: 0.1, attack: 0.05, curve: 'lin', voice: v });
  },

  defeat(v) {
    const notes = [440, 349, 262];
    repeat(3, 0.28, (i, at) => {
      tone({ type: 'triangle', freq: notes[i], dur: 0.9, gain: 0.1, attack: 0.01, delay: at, voice: v });
      tone({ type: 'sine', freq: notes[i] / 2, dur: 0.8, gain: 0.06, attack: 0.02, delay: at, voice: v });
    });
    noiseBurst({ noise: 'pink', dur: 1.4, gain: 0.06, filter: 'lowpass', freq: 400, to: 90, attack: 0.4, curve: 'lin', voice: v });
  },

  // Target locking: a rising tone ladder that stalls on the confirm.
  lockOn(v) {
    repeat(3, 0.08, (i, at) => {
      tone({ type: 'square', freq: 700 + i * 260, dur: 0.05, gain: 0.055, attack: 0.001, delay: at, voice: v });
    });
    tone({ type: 'sawtooth', freq: 1240, to: 1560, dur: 0.4, gain: 0.05, attack: 0.05, delay: 0.24, curve: 'lin', voice: v });
    tone({ type: 'sine', freq: 1560, dur: 0.3, gain: 0.045, attack: 0.01, delay: 0.3, voice: v });
  },

  targetPing(v) {
    tone({ type: 'sine', freq: 1046, to: 990, dur: 0.45, gain: 0.09, attack: 0.002, voice: v });
    tone({ type: 'sine', freq: 1568, dur: 0.25, gain: 0.03, attack: 0.002, voice: v });
    noiseBurst({ dur: 0.05, gain: 0.05, filter: 'bandpass', freq: 3000, q: 8, voice: v });
  },
};

// Short tremolo on the voice strip — used by shieldHit for the field wobble.
// Modulating the shared strip (rather than each oscillator) keeps it to 2 nodes.
function wobble(v) {
  if (!S.ctx) return;
  const lfo = S.ctx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = 17;
  const depth = S.ctx.createGain();
  depth.gain.value = 0.35;
  lfo.connect(depth);
  depth.connect(v.in.gain);
  v.parts.push(lfo, depth);
  const t0 = S.ctx.currentTime;
  depth.gain.setValueAtTime(0.35, t0 + 0.05);
  depth.gain.linearRampToValueAtTime(0.0001, t0 + 0.5);
  lfo.start(t0);
  lfo.stop(t0 + 0.55);
  // The LFO outruns the pings it colours, so it holds the voice open too.
  expectEnd(v, lfo);
}

// -------------------------------------------------------------------- music
// Ambient bed: a slow detuned drone + a sparse pentatonic figure placed by a
// lookahead scheduler. Web Audio clocks run ahead of the JS timer queue, so we
// queue note events 0.6s out and let the audio clock own the timing — a plain
// setInterval on note spacing drifts audibly within a minute.

const PENTA = [0, 3, 5, 7, 10]; // minor pentatonic — no note is ever "wrong"
const MUSIC_ROOT = 45; // A2

function midiToFreq(m) {
  return 440 * Math.pow(2, (m - 69) / 12);
}

function musicNote(freq, when, gain, pan) {
  if (!S.ctx || !S.musicBus) return;
  const parts = [];
  const osc = S.ctx.createOscillator();
  osc.type = 'triangle';
  osc.frequency.value = freq;
  const harm = S.ctx.createOscillator();
  harm.type = 'sine';
  harm.frequency.value = freq * 2.01; // 1 cent-off octave: slow beating, no chorus node
  const g = S.ctx.createGain();
  const hg = S.ctx.createGain();
  hg.gain.value = 0.3;
  const dur = rnd(1.1, 1.9);
  envelope(g.gain, gain, 0.06, dur, 'exp', when);
  osc.connect(g);
  harm.connect(hg);
  hg.connect(g);
  parts.push(osc, harm, g, hg);
  let out = g;
  if (typeof S.ctx.createStereoPanner === 'function') {
    const p = S.ctx.createStereoPanner();
    p.pan.value = pan;
    out.connect(p);
    parts.push(p);
    out = p;
  }
  out.connect(S.musicBus);
  if (S.reverb) {
    const send = S.ctx.createGain();
    send.gain.value = 0.55;
    out.connect(send);
    send.connect(S.reverb.input);
    parts.push(send);
  }
  osc.start(when);
  osc.stop(when + dur + 0.05);
  harm.start(when);
  harm.stop(when + dur + 0.05);
  // Both oscillators stop on the same sample, so one handler releasing the
  // shared `parts` list is enough (and never cuts the other one short).
  cleanupOnEnd(osc, parts);
}

function buildAmbient() {
  const ctx = S.ctx;
  const bus = ctx.createGain();
  bus.gain.value = 0.0001;
  bus.connect(S.musicBus);

  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 170;
  lp.Q.value = 3.5;
  lp.connect(bus);

  const drone = ctx.createGain();
  drone.gain.value = 0.16;
  drone.connect(lp);

  const oscs = [];
  const partials = [
    { f: 55, type: 'sawtooth', g: 0.5 },
    { f: 55.25, type: 'sawtooth', g: 0.4 },
    { f: 82.5, type: 'sine', g: 0.35 },
    { f: 110.15, type: 'triangle', g: 0.18 },
  ];
  for (const p of partials) {
    const o = ctx.createOscillator();
    o.type = p.type;
    o.frequency.value = p.f;
    const g = ctx.createGain();
    g.gain.value = p.g;
    o.connect(g);
    g.connect(drone);
    o.start();
    oscs.push(o);
  }

  // Very slow cutoff LFO so the drone breathes without any per-frame work.
  const lfo = ctx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = 0.045;
  const lfoDepth = ctx.createGain();
  lfoDepth.gain.value = 55;
  lfo.connect(lfoDepth);
  lfoDepth.connect(lp.frequency);
  lfo.start();

  const pad = ctx.createOscillator();
  pad.type = 'sine';
  pad.frequency.value = 0.017;
  const padGain = ctx.createGain();
  padGain.gain.value = 0.045;
  pad.connect(padGain);
  padGain.connect(bus);
  pad.start();

  const hiss = ctx.createBufferSource();
  hiss.buffer = S.buffers.pink;
  hiss.loop = true;
  const hissLp = ctx.createBiquadFilter();
  hissLp.type = 'lowpass';
  hissLp.frequency.value = 380;
  const hissGain = ctx.createGain();
  hissGain.gain.value = 0.03;
  hiss.connect(hissLp);
  hissLp.connect(hissGain);
  hissGain.connect(bus);
  hiss.start();

  // Dissonance layer, silent at tension 0 and opened up as the fight tightens.
  const dis = ctx.createGain();
  dis.gain.value = 0.0001;
  dis.connect(lp);
  const disOscs = [55 * 1.0595, 55 * Math.SQRT2, 110 * 1.0595].map((f) => {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = f;
    const g = ctx.createGain();
    g.gain.value = 0.34;
    o.connect(g);
    g.connect(dis);
    o.start();
    return o;
  });

  ramp(bus.gain, 1, 3.5);
  return { bus, lp, drone, lfo, lfoDepth, pad, padGain, hiss, hissLp, hissGain, dis, oscs, disOscs };
}

function destroyAmbient(fast) {
  const a = S.ambient;
  stopMusicTimer();
  S.ambient = null;
  if (!a) return;
  const stopAt = S.ctx ? S.ctx.currentTime + (fast ? 0.05 : 1.2) : 0;
  try {
    a.bus.gain.cancelScheduledValues(S.ctx.currentTime);
    a.bus.gain.setValueAtTime(a.bus.gain.value, S.ctx.currentTime);
    a.bus.gain.linearRampToValueAtTime(0, stopAt);
  } catch {
    /* context already closed */
  }
  // `hiss` loops forever, so it must be stopped explicitly: disconnecting alone
  // would leave a running source node alive until the context is torn down.
  for (const o of [...a.oscs, ...a.disOscs, a.lfo, a.pad, a.hiss]) {
    try {
      o.stop(stopAt + 0.05);
    } catch {
      /* already stopped */
    }
  }
  const nodes = [a.bus, a.lp, a.drone, a.lfoDepth, a.padGain, a.hissLp, a.hissGain, a.dis, ...a.oscs, ...a.disOscs, a.hiss];
  const ms = (stopAt - (S.ctx ? S.ctx.currentTime : 0)) * 1000 + 250;
  // A timer rather than an `onended` fan-out: the fade leaves six sources to
  // coordinate, and the disconnect only has to happen after the ramp ends.
  setTimeout(() => {
    for (const n of nodes) safeDisconnect(n);
  }, Math.max(80, ms));
}

function scheduleMusic() {
  const ctx = S.ctx;
  if (!ctx) return;
  const now = ctx.currentTime;
  if (S.nextNoteTime < now) S.nextNoteTime = now + 0.05; // fell behind: resync, never burst-schedule
  while (S.nextNoteTime < now + LOOKAHEAD) {
    S.tensionShown += (S.tension - S.tensionShown) * 0.09; // ~8Hz smoothing, no per-frame cost
    const t = S.tensionShown;
    const bpm = 38 + 76 * t;
    const gap = (60 / bpm / 2) / clamp(S.speed, 0.25, 8); // eighth notes
    const step = S.step++;
    const density = 0.16 + 0.42 * t;
    const onBeat = step % 4 === 0;
    if (onBeat || Math.random() < density) {
      const deg = PENTA[Math.floor(Math.random() * PENTA.length)];
      const oct = Math.random() < 0.25 + 0.3 * t ? 12 : 0;
      const midi = MUSIC_ROOT + deg + oct + (onBeat && t > 0.6 ? 12 : 0);
      const vel = (onBeat ? 0.13 : 0.08) * (0.6 + 0.5 * Math.random()) * (0.55 + 0.6 * t);
      musicNote(midiToFreq(midi), S.nextNoteTime + rnd(0, 0.02), vel, rnd(-0.5, 0.5));
      if (t > 0.65 && onBeat) {
        musicNote(midiToFreq(MUSIC_ROOT - 12), S.nextNoteTime, 0.12 * t, 0);
      }
    }
    S.nextNoteTime += gap;
  }
}

function startMusicTimer() {
  if (S.musicTimer || !S.ctx || !S.ambient) return;
  if (S.muted || S.music <= 0.0005) return;
  S.nextNoteTime = S.ctx.currentTime + 0.25;
  S.step = 0;
  S.musicTimer = setInterval(scheduleMusic, TICK_MS);
}

function stopMusicTimer() {
  if (S.musicTimer) clearInterval(S.musicTimer);
  S.musicTimer = 0;
}

// Reconciles "user wants ambient" with "audio is actually available".
function syncRuntime() {
  if (!S.ctx) return;
  if (S.ambientWanted && !S.ambient) {
    S.ambient = buildAmbient();
    startMusicTimer();
  }
  if (!S.ambientWanted && S.ambient) destroyAmbient(false);
  if (S.ambient && (S.muted || S.music <= 0.0005)) stopMusicTimer();
  else if (S.ambient) startMusicTimer();
}

// ------------------------------------------------------------------- resume

function resumeCtx() {
  if (!S.ctx || S.ctx.state === 'running' || S.ctx.state === 'closed') return;
  const p = S.ctx.resume();
  if (p && typeof p.catch === 'function') p.catch(noop);
}

// Chrome creates the context suspended until a gesture lands. If init() was not
// called from one, park a one-shot listener so the first click/keypress unlocks.
function armGestureResume() {
  if (!win || typeof win.addEventListener !== 'function') return;
  if (S.gestureOff) return;
  const events = ['pointerdown', 'touchend', 'keydown'];
  const onGesture = () => {
    if (S.ctx && S.ctx.state === 'suspended' && !S.userSuspended) {
      const p = S.ctx.resume();
      // A gesture can be refused, so stay armed until the clock truly runs.
      if (p && typeof p.then === 'function') p.then(disarmGestureResume, noop);
      else disarmGestureResume();
    } else {
      disarmGestureResume();
    }
  };
  for (const ev of events) win.addEventListener(ev, onGesture, { passive: true, capture: true });
  // Stored as a closure rather than an AbortController so removal works on the
  // older engines without one, and so disarm is the same path either way.
  S.gestureOff = () => {
    for (const ev of events) win.removeEventListener(ev, onGesture, { capture: true });
  };
}

function disarmGestureResume() {
  if (!S.gestureOff) return;
  const off = S.gestureOff;
  S.gestureOff = null;
  off();
}

// ----------------------------------------------------------------- public API

/**
 * Procedural sound engine for Void Lance. All synthesis happens on first use;
 * every method is safe to call before init() and in environments with no
 * WebAudio implementation, where it degrades to a no-op.
 */
export const audio = {
  /** Create the AudioContext and bus graph. Call from a user gesture; idempotent. */
  init() {
    if (!S.available) return;
    if (S.ctx && S.ctx.state !== 'closed') {
      resumeCtx();
      syncRuntime();
      return;
    }
    let ctx = null;
    try {
      ctx = new AudioCtor({ latencyHint: 'interactive' });
      buildGraph(ctx);
    } catch {
      S.available = false;
      S.ctx = null;
      return;
    }
    if (ctx.state === 'suspended') armGestureResume();
    resumeCtx();
    syncRuntime();
  },

  /** True when a live AudioContext and bus graph exist. */
  get ready() {
    return Boolean(S.ctx) && S.available && S.ctx.state !== 'closed';
  },

  /** Mute everything (ramped, no click). Stops the music scheduler entirely. */
  setMuted(v) {
    const on = Boolean(v);
    if (on === S.muted) return;
    S.muted = on;
    ramp(S.masterGain ? S.masterGain.gain : null, on ? 0 : S.master, 0.05);
    if (S.ctx) syncRuntime();
  },

  getMuted() {
    return S.muted;
  },

  setMasterVolume(v01) {
    S.master = clamp01(v01);
    if (!S.muted) ramp(S.masterGain ? S.masterGain.gain : null, S.master, 0.05);
  },

  setMusicVolume(v01) {
    S.music = clamp01(v01);
    ramp(S.musicBus ? S.musicBus.gain : null, S.music, 0.08);
    if (S.ctx) syncRuntime();
  },

  setSfxVolume(v01) {
    S.sfx = clamp01(v01);
    ramp(S.sfxBus ? S.sfxBus.gain : null, S.sfx, 0.05);
  },

  getMasterVolume() {
    return S.master;
  },

  getMusicVolume() {
    return S.music;
  },

  getSfxVolume() {
    return S.sfx;
  },

  /**
   * Fire a one-shot. Unknown names, missing context and a full voice budget all
   * return silently; this never throws, because it is called from the render loop.
   * @param {string} name one of uiHover, uiClick, uiBack, select, move, thruster,
   *   fireKinetic, fireEnergy, fireTorpedo, fireMissile, shieldHit, armorHit,
   *   hullHit, explodeSmall, explodeLarge, shieldUp, repair, system, error,
   *   turnStart, enemyTurn, victory, defeat, lockOn, targetPing.
   * @param {{gain?:number,rate?:number,pan?:number,delay?:number,detune?:number}} [opts]
   */
  play(name, opts) {
    if (!audio.ready || S.muted) return;
    const def = SOUNDS[name];
    if (typeof def !== 'function') return;
    const o = opts || {};
    let voice = null;
    try {
      voice = openVoice({
        gain: num(o.gain, 1),
        rate: num(o.rate, 1),
        pan: num(o.pan, 0),
        delay: num(o.delay, 0),
        detune: num(o.detune, 0),
        wet: num(o.wet, 0.12),
      });
      if (!voice) return;
      def(voice);
      // A def that allocated nothing would otherwise hold a budget slot forever.
      if (voice.pending === 0) closeVoice(voice);
    } catch {
      closeVoice(voice);
    }
  },

  /** Start the generative drone + arpeggio. Idempotent; works before init(). */
  startAmbient() {
    S.ambientWanted = true;
    syncRuntime();
  },

  /** Fade the ambient bed out and release its nodes. Idempotent. */
  stopAmbient() {
    S.ambientWanted = false;
    if (S.ambient) destroyAmbient(false);
    stopMusicTimer();
  },

  /**
   * Morph the bed: raises drone cutoff/gain, opens the dissonance layer and
   * makes the arpeggio faster and denser. Smoothed inside the scheduler.
   * @param {number} t01 0 = calm, 1 = last ship against the last ship.
   */
  setTension(t01) {
    const t = clamp01(t01);
    S.tension = t;
    const a = S.ambient;
    if (!a || !S.ctx) return;
    ramp(a.lp.frequency, 165 + 900 * t, 1.6);
    ramp(a.lfoDepth.gain, 55 + 260 * t, 1.6);
    ramp(a.drone.gain, 0.16 + 0.1 * t, 1.4);
    ramp(a.dis.gain, t < 0.18 ? 0.0001 : 0.02 + 0.075 * t, 2.2);
    ramp(a.hissGain.gain, 0.03 + 0.05 * t, 1.8);
    ramp(a.hissLp.frequency, 380 + 900 * t, 1.8);
  },

  /** Park the context (tab blur / pause menu). */
  suspend() {
    S.userSuspended = true;
    stopMusicTimer();
    if (!S.ctx || S.ctx.state !== 'running') return;
    const p = S.ctx.suspend();
    if (p && typeof p.catch === 'function') p.catch(noop);
  },

  /** Restart the context after suspend(); also clears autoplay blocks. */
  resume() {
    S.userSuspended = false;
    if (!S.ctx) return;
    resumeCtx();
    if (S.ambient) startMusicTimer();
  },

  /** Game playback speed; scales note spacing only, never pitch. */
  setSpeed(mult) {
    const m = num(mult, 1);
    S.speed = m === 0.5 || m === 1 || m === 2 || m === 4 ? m : clamp(m, 0.5, 4);
  },

  /** Tear everything down. A later init() rebuilds from scratch. */
  dispose() {
    stopMusicTimer();
    disarmGestureResume();
    if (S.ambient) destroyAmbient(true);
    S.ambientWanted = false;
    for (const v of [...S.voices]) {
      for (const n of v.parts) {
        if (n && typeof n.stop === 'function') {
          try {
            n.stop();
          } catch {
            /* not started */
          }
        }
      }
      closeVoice(v);
    }
    S.voices.clear();
    safeDisconnect(S.sfxSend);
    S.sfxSend = null;
    if (S.reverb) {
      for (const n of S.reverb.nodes) safeDisconnect(n);
      S.reverb = null;
    }
    const ctx = S.ctx;
    S.ctx = null;
    S.masterGain = null;
    S.limiter = null;
    S.sfxBus = null;
    S.musicBus = null;
    S.buffers = null;
    S.tension = 0;
    S.tensionShown = 0;
    if (ctx && ctx.state !== 'closed') {
      const p = ctx.close();
      if (p && typeof p.catch === 'function') p.catch(noop);
    }
  },
};

export default audio;

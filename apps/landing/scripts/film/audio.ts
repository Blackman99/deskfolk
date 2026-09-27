/**
 * The film's soundtrack, synthesized: a 96 BPM lo-fi groove composed to the film's
 * timeline (drums enter on step 1, drop out while the window hides in the tray, and a
 * ii–V–I lands on the end card), plus interface sounds placed on the cues the film
 * stage recorded. Everything here is generated, so the result carries no licence.
 *
 * `--music <file>` in render.ts swaps the groove for a track of your own; the
 * interface sounds are still laid on top.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

export const SR = 48000;

export type Timeline = {
  bpm: number;
  barMs: number;
  totalBars: number;
  durationMs: number;
  bars: { logo: number; hero: number; steps: number[]; trust: number; end: number; tail: number };
};

export type Cue = { t: number; type: string };

type Stereo = { L: Float32Array; R: Float32Array };

function stereo(n: number): Stereo {
  return { L: new Float32Array(n), R: new Float32Array(n) };
}

const TAU = Math.PI * 2;

function mtof(m: number): number {
  return 440 * 2 ** ((m - 69) / 12);
}

function dbToGain(db: number): number {
  return 10 ** (db / 20);
}

/** Deterministic noise, so two renders of the same cut sound the same. */
class Rng {
  s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  bi(): number {
    return this.next() * 2 - 1;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
}

class Biquad {
  b0 = 1;
  b1 = 0;
  b2 = 0;
  a1 = 0;
  a2 = 0;
  z1 = 0;
  z2 = 0;
  constructor(type: 'lp' | 'hp' | 'bp', f: number, q = 0.707) {
    this.set(type, f, q);
  }
  set(type: 'lp' | 'hp' | 'bp', f: number, q = 0.707): void {
    const w = (TAU * Math.min(f, SR * 0.45)) / SR;
    const cw = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha;
    let b0: number;
    let b1: number;
    let b2: number;
    if (type === 'lp') {
      b0 = (1 - cw) / 2;
      b1 = 1 - cw;
      b2 = (1 - cw) / 2;
    } else if (type === 'hp') {
      b0 = (1 + cw) / 2;
      b1 = -(1 + cw);
      b2 = (1 + cw) / 2;
    } else {
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
    }
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = (-2 * cw) / a0;
    this.a2 = (1 - alpha) / a0;
  }
  run(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

/* ───────── Effects ───────── */

class Comb {
  buf: Float32Array;
  idx = 0;
  store = 0;
  constructor(n: number) {
    this.buf = new Float32Array(n);
  }
  run(x: number, fb: number, damp: number): number {
    const y = this.buf[this.idx];
    this.store = y * (1 - damp) + this.store * damp;
    this.buf[this.idx] = x + this.store * fb;
    if (++this.idx >= this.buf.length) this.idx = 0;
    return y;
  }
}

class Allpass {
  buf: Float32Array;
  idx = 0;
  constructor(n: number) {
    this.buf = new Float32Array(n);
  }
  run(x: number): number {
    const b = this.buf[this.idx];
    this.buf[this.idx] = x + b * 0.5;
    if (++this.idx >= this.buf.length) this.idx = 0;
    return b - x;
  }
}

/** Freeverb: eight damped combs and four allpasses per side. */
function reverb(send: Stereo, room: number, damp: number): Stereo {
  const k = SR / 44100;
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
  const aps = [556, 441, 341, 225];
  const out = stereo(send.L.length);
  for (const [side, spread] of [['L', 0], ['R', 23]] as const) {
    const cs = combs.map((n) => new Comb(Math.round((n + spread) * k)));
    const as = aps.map((n) => new Allpass(Math.round((n + spread) * k)));
    const dst = out[side];
    const fb = room * 0.28 + 0.7;
    for (let i = 0; i < dst.length; i++) {
      const x = (send.L[i] + send.R[i]) * 0.015;
      let y = 0;
      for (const c of cs) y += c.run(x, fb, damp);
      for (const a of as) y = a.run(y);
      dst[i] = y;
    }
  }
  return out;
}

/** Ping-pong delay with a darkening feedback path. */
function pingPong(send: Stereo, delaySec: number, feedback: number): Stereo {
  const n = Math.round(delaySec * SR);
  const bl = new Float32Array(n);
  const br = new Float32Array(n);
  const lpL = new Biquad('lp', 3200);
  const lpR = new Biquad('lp', 3200);
  const out = stereo(send.L.length);
  let idx = 0;
  for (let i = 0; i < out.L.length; i++) {
    const dl = bl[idx];
    const dr = br[idx];
    out.L[i] = dl;
    out.R[i] = dr;
    bl[idx] = lpL.run((send.L[i] + send.R[i]) * 0.5 + dr * feedback);
    br[idx] = lpR.run(dl * feedback);
    if (++idx >= n) idx = 0;
  }
  return out;
}

function mixInto(dst: Stereo, src: Stereo, gain = 1): void {
  for (let i = 0; i < dst.L.length; i++) {
    dst.L[i] += src.L[i] * gain;
    dst.R[i] += src.R[i] * gain;
  }
}

/** RMS over the parts of a stem that actually sound, ignoring its silences. */
function activeRms(s: Stereo): number {
  const win = 2400;
  const powers: number[] = [];
  for (let i = 0; i + win <= s.L.length; i += win) {
    let p = 0;
    for (let j = i; j < i + win; j++) p += s.L[j] * s.L[j] + s.R[j] * s.R[j];
    powers.push(p / (2 * win));
  }
  const max = Math.max(0, ...powers);
  const loud = powers.filter((p) => p > max * 1e-3);
  if (loud.length === 0) return 0;
  return Math.sqrt(loud.reduce((a, b) => a + b, 0) / loud.length);
}

function levelTo(s: Stereo, db: number): void {
  const r = activeRms(s);
  if (r === 0) return;
  const g = dbToGain(db) / r;
  for (let i = 0; i < s.L.length; i++) {
    s.L[i] *= g;
    s.R[i] *= g;
  }
}

function peak(s: Stereo): number {
  let p = 0;
  for (let i = 0; i < s.L.length; i++) p = Math.max(p, Math.abs(s.L[i]), Math.abs(s.R[i]));
  return p;
}

function panGains(pan: number): [number, number] {
  const a = ((pan + 1) * Math.PI) / 4;
  return [Math.cos(a), Math.sin(a)];
}

/* ───────── Instruments ───────── */

/** Two-operator FM electric piano with a bell-like tine on the attack. */
function ep(out: Stereo, t0: number, dur: number, midi: number, vel: number, pan: number): void {
  const f = mtof(midi);
  const n0 = Math.round(t0 * SR);
  const rel = 0.28;
  const len = Math.round((dur + rel * 4) * SR);
  const decay = 1.9 - (midi - 48) * 0.02;
  const [gl, gr] = panGains(pan);
  for (let i = 0; i < len; i++) {
    const n = n0 + i;
    if (n >= out.L.length) break;
    const t = i / SR;
    let env = Math.min(1, t / 0.003) * Math.exp(-t / decay);
    if (t > dur) env *= Math.exp(-(t - dur) / rel);
    const ph = TAU * f * t;
    const index = (1.1 * vel + 0.25) * Math.exp(-t / 0.22) + 0.2;
    let y = Math.sin(ph + index * Math.sin(ph));
    y += 0.12 * vel * Math.sin(ph * 7.1) * Math.exp(-t / 0.035);
    y *= env * vel;
    const trem = 0.5 + 0.5 * Math.sin(TAU * 4.1 * (t0 + t));
    out.L[n] += y * gl * (1 - 0.22 * trem);
    out.R[n] += y * gr * (1 - 0.22 * (1 - trem));
  }
}

/** Soft string-ish pad: two detuned band-limited saws through a low-pass. */
function pad(out: Stereo, t0: number, dur: number, midi: number, vel: number): void {
  const n0 = Math.round(t0 * SR);
  const attack = 0.7;
  const rel = 1.1;
  const len = Math.round((dur + rel * 3) * SR);
  for (const [detune, pan] of [
    [-7, -0.55],
    [7, 0.55]
  ] as const) {
    const f = mtof(midi + detune / 100);
    const dt = f / SR;
    const lp = new Biquad('lp', 1500, 0.6);
    const [gl, gr] = panGains(pan);
    let p = (detune + 7) / 17;
    for (let i = 0; i < len; i++) {
      const n = n0 + i;
      if (n >= out.L.length) break;
      const t = i / SR;
      let env = Math.min(1, t / attack);
      if (t > dur) env *= Math.exp(-(t - dur) / rel);
      p += dt;
      if (p >= 1) p -= 1;
      let saw = 2 * p - 1;
      if (p < dt) {
        const x = p / dt;
        saw -= x + x - x * x - 1;
      } else if (p > 1 - dt) {
        const x = (p - 1) / dt;
        saw -= x * x + x + x + 1;
      }
      const y = lp.run(saw) * env * vel;
      out.L[n] += y * gl;
      out.R[n] += y * gr;
    }
  }
}

function bass(out: Stereo, t0: number, dur: number, midi: number, vel: number): void {
  const f = mtof(midi);
  const n0 = Math.round(t0 * SR);
  const len = Math.round((dur + 0.12) * SR);
  for (let i = 0; i < len; i++) {
    const n = n0 + i;
    if (n >= out.L.length) break;
    const t = i / SR;
    let env = Math.min(1, t / 0.006) * (0.7 + 0.3 * Math.exp(-t / 0.25));
    if (t > dur) env *= Math.exp(-(t - dur) / 0.03);
    const ph = TAU * f * t;
    const y = Math.tanh(1.6 * (Math.sin(ph) + 0.25 * Math.sin(2 * ph))) * env * vel;
    out.L[n] += y;
    out.R[n] += y;
  }
}

/** Karplus-Strong pluck. */
function pluck(out: Stereo, t0: number, midi: number, vel: number, pan: number, rng: Rng): void {
  const f = mtof(midi);
  const period = Math.max(2, Math.round(SR / f));
  const line = new Float32Array(period);
  const lp = new Biquad('lp', 2600);
  for (let i = 0; i < period; i++) line[i] = lp.run(rng.bi());
  const n0 = Math.round(t0 * SR);
  const len = Math.round(1.6 * SR);
  const [gl, gr] = panGains(pan);
  let idx = 0;
  let prev = 0;
  for (let i = 0; i < len; i++) {
    const n = n0 + i;
    if (n >= out.L.length) break;
    const cur = line[idx];
    const y = (cur + prev) * 0.5 * 0.996;
    prev = cur;
    line[idx] = y;
    if (++idx >= period) idx = 0;
    const v = y * vel * Math.min(1, i / 48);
    out.L[n] += v * gl;
    out.R[n] += v * gr;
  }
}

function kick(out: Stereo, t0: number, vel: number): void {
  const n0 = Math.round(t0 * SR);
  const len = Math.round(0.5 * SR);
  let ph = 0;
  for (let i = 0; i < len; i++) {
    const n = n0 + i;
    if (n >= out.L.length) break;
    const t = i / SR;
    const f = 46 + 105 * Math.exp(-t / 0.032);
    ph += (TAU * f) / SR;
    const click = t < 0.004 ? (1 - t / 0.004) * 0.35 : 0;
    const y = Math.tanh(1.4 * (Math.sin(ph) + click)) * Math.exp(-t / 0.26) * vel;
    out.L[n] += y;
    out.R[n] += y;
  }
}

function snare(out: Stereo, t0: number, vel: number, rng: Rng): void {
  const n0 = Math.round(t0 * SR);
  const len = Math.round(0.4 * SR);
  const bp = new Biquad('bp', 1900, 0.7);
  const hp = new Biquad('hp', 400);
  for (let i = 0; i < len; i++) {
    const n = n0 + i;
    if (n >= out.L.length) break;
    const t = i / SR;
    const noise = hp.run(bp.run(rng.bi())) * Math.exp(-t / 0.11);
    const body = Math.sin(TAU * 185 * t) * Math.exp(-t / 0.045) * 0.5;
    const y = (noise * 1.6 + body) * vel;
    out.L[n] += y * 0.95;
    out.R[n] += y;
  }
}

function hat(out: Stereo, t0: number, vel: number, open: boolean, rng: Rng): void {
  const n0 = Math.round(t0 * SR);
  const decay = open ? 0.16 : 0.028;
  const len = Math.round(decay * 6 * SR);
  const hp = new Biquad('hp', 7200, 0.8);
  for (let i = 0; i < len; i++) {
    const n = n0 + i;
    if (n >= out.L.length) break;
    const t = i / SR;
    const y = hp.run(rng.bi()) * Math.exp(-t / decay) * vel;
    out.L[n] += y * 0.85;
    out.R[n] += y;
  }
}

/** Filtered-noise swell that leads into a section. */
function riser(out: Stereo, t0: number, dur: number, rng: Rng): void {
  const n0 = Math.round(t0 * SR);
  const len = Math.round(dur * SR);
  const bp = new Biquad('bp', 300, 1.2);
  for (let i = 0; i < len; i++) {
    const n = n0 + i;
    if (n >= out.L.length) break;
    const x = i / len;
    if (i % 64 === 0) bp.set('bp', 300 * (5000 / 300) ** x, 1.2);
    const y = bp.run(rng.bi()) * x * x;
    out.L[n] += y * (1 - 0.3 * x);
    out.R[n] += y * (0.7 + 0.3 * x);
  }
}

/** Low thump with a noise bloom, for a section landing. */
function impact(out: Stereo, t0: number, rng: Rng): void {
  const n0 = Math.round(t0 * SR);
  const len = Math.round(1.6 * SR);
  const lp = new Biquad('lp', 900);
  let ph = 0;
  for (let i = 0; i < len; i++) {
    const n = n0 + i;
    if (n >= out.L.length) break;
    const t = i / SR;
    ph += (TAU * (38 + 30 * Math.exp(-t / 0.15))) / SR;
    const y = Math.sin(ph) * Math.exp(-t / 0.5) + lp.run(rng.bi()) * Math.exp(-t / 0.35) * 0.5;
    out.L[n] += y;
    out.R[n] += y;
  }
}

/** Faint record crackle and hiss under the whole piece. */
function vinyl(out: Stereo, rng: Rng): void {
  const hp = new Biquad('hp', 1500);
  const hiss = new Biquad('lp', 5000);
  let spike = 0;
  for (let i = 0; i < out.L.length; i++) {
    if (rng.next() < 7 / SR) spike = rng.range(0.3, 1) * (rng.next() < 0.5 ? -1 : 1);
    const c = hp.run(spike);
    spike *= 0.6;
    const h = hiss.run(rng.bi()) * 0.08;
    out.L[i] += c + h;
    out.R[i] += c * 0.8 + h;
  }
}

/* ───────── Arrangement ───────── */

type Chord = { bass: number; notes: number[] };

const LOOP: Chord[] = [
  { bass: 41, notes: [57, 60, 64, 67] }, // Fmaj9
  { bass: 40, notes: [55, 59, 62, 64] }, // Em7
  { bass: 38, notes: [53, 57, 60, 64] }, // Dm9
  { bass: 36, notes: [52, 55, 59, 62] } // Cmaj9
];
const G13SUS: Chord = { bass: 43, notes: [53, 57, 60, 64] };
const FINAL: Chord = { bass: 36, notes: [52, 55, 59, 62, 67] };

type Section = 'logo' | 'hero' | 'steps' | 'trust' | 'end' | 'tail';

export function composeMusic(tl: Timeline): Stereo {
  const n = Math.ceil((tl.durationMs / 1000) * SR);
  const barSec = tl.barMs / 1000;
  const stepSec = barSec / 16;
  const swing = 0.18;
  const rng = new Rng(7);
  const { bars } = tl;

  const section = (b: number): Section =>
    b < bars.hero ? 'logo' : b < bars.steps[0] ? 'hero' : b < bars.trust ? 'steps' : b < bars.end ? 'trust' : b < bars.tail ? 'end' : 'tail';
  const sceneOf = (b: number): number => {
    let s = 0;
    bars.steps.forEach((start, i) => {
      if (b >= start) s = i + 1;
    });
    return s;
  };
  const chordOf = (b: number): Chord => {
    if (b === bars.end) return G13SUS;
    if (b > bars.end) return FINAL;
    return LOOP[(((b - bars.steps[0]) % 4) + 4) % 4];
  };
  const at = (b: number, step: number) => b * barSec + step * stepSec + (step % 2 ? swing * stepSec : 0);

  const keys = stereo(n);
  const pads = stereo(n);
  const low = stereo(n);
  const plucks = stereo(n);
  const kicks = stereo(n);
  const snares = stereo(n);
  const hats = stereo(n);
  const fx = stereo(n);
  const kickTimes: number[] = [];

  for (let b = 0; b < tl.totalBars; b++) {
    const sec = section(b);
    const scene = sceneOf(b);
    const chord = chordOf(b);
    const breakdown = scene === 10;
    const full = sec === 'steps' && !breakdown;
    const lift = full && scene >= 4;
    const t = b * barSec;

    // Pad under everything; the final chord is held through the tail.
    if (sec !== 'tail') {
      const dur = b === bars.end + 1 ? barSec * 2 : barSec;
      for (const m of [...chord.notes, chord.bass + 24]) pad(pads, t, dur, m, 0.5);
    }

    // Electric piano.
    const strum = (start: number, dur: number, vel: number, notes: number[] = chord.notes) =>
      notes.forEach((m, i) => ep(keys, start + i * 0.011 + rng.range(-0.004, 0.004), dur, m, vel * rng.range(0.92, 1.05), -0.25 + i * 0.16));
    if (sec === 'logo') strum(t, barSec * 0.95, 0.55);
    else if (sec === 'end' || sec === 'tail') {
      if (b === bars.end) strum(t, barSec * 0.95, 0.6);
      if (b === bars.end + 1) strum(t, barSec * 2.6, 0.65, chord.notes);
    } else if (breakdown) strum(t, barSec * 0.95, 0.5);
    else {
      const soft = sec === 'hero' || sec === 'trust' ? 0.8 : 1;
      if (b % 2 === 0) {
        strum(at(b, 0), stepSec * 5, 0.62 * soft);
        strum(at(b, 6), stepSec * 3, 0.42 * soft);
        strum(at(b, 10), stepSec * 5.5, 0.52 * soft);
      } else {
        strum(at(b, 0), stepSec * 8, 0.6 * soft);
        strum(at(b, 11), stepSec * 4.5, 0.46 * soft);
      }
    }

    // Bass.
    if (sec === 'hero' || sec === 'trust' || breakdown || sec === 'end') {
      const dur = b === bars.end + 1 ? barSec * 2 : barSec * 0.96;
      if (sec !== 'end' || b <= bars.end + 1) bass(low, t, dur, chord.bass, breakdown ? 0.6 : 0.8);
    } else if (full) {
      bass(low, at(b, 0), stepSec * 6, chord.bass, 0.95);
      bass(low, at(b, 10), stepSec * 4.5, chord.bass, 0.8);
      if (b % 2 === 1) bass(low, at(b, 14), stepSec * 1.6, chord.bass + 12, 0.55);
    }

    // Drums.
    if (full) {
      for (const [step, vel] of [
        [0, 1],
        [7, 0.5],
        [10, 0.85]
      ] as const) {
        kick(kicks, at(b, step), vel);
        kickTimes.push(at(b, step));
      }
      if (lift) {
        snare(snares, at(b, 4), 0.9, rng);
        snare(snares, at(b, 12), 0.95, rng);
        if (b % 4 === 3) snare(snares, at(b, 15), 0.3, rng);
      }
      for (let s = 0; s < 16; s += lift ? 1 : 2) {
        const accent = s % 4 === 2 ? 1 : s % 2 === 0 ? 0.7 : 0.35;
        hat(hats, at(b, s), accent * rng.range(0.85, 1.05), lift && s === 14 && b % 2 === 1, rng);
      }
    } else if (breakdown) {
      for (let s = 2; s < 16; s += 4) hat(hats, at(b, s), 0.5, false, rng);
    }

    // Plucked arpeggio from the group scene on, and softly under the trust points.
    if (lift || sec === 'trust') {
      const tones = chord.notes.map((m) => m + 12);
      const order = [0, 1, 2, 3, 1, 2, 3, 2];
      order.forEach((k, i) => {
        const vel = (i % 2 === 0 ? 0.55 : 0.4) * (sec === 'trust' ? 0.7 : 1);
        pluck(plucks, at(b, i * 2), tones[k], vel, i % 2 ? 0.35 : -0.35, rng);
      });
    }
  }

  // Risers into step 1 and back out of the breakdown; landings on both.
  const breakdownStart = bars.steps[9];
  const returnBar = bars.steps[10];
  riser(fx, (bars.steps[0] - 1) * barSec, barSec, rng);
  riser(fx, (returnBar - 1) * barSec, barSec, rng);
  impact(fx, bars.steps[0] * barSec, rng);
  impact(fx, returnBar * barSec, rng);

  // Keys and pad open up over the intro and close down while the window hides.
  const cutoff = (sec: number): number => {
    const b = sec / barSec;
    if (b < bars.steps[0]) return 500 * (16000 / 500) ** Math.min(1, b / bars.steps[0]);
    if (b >= breakdownStart && b < returnBar) {
      const x = (b - breakdownStart) / (returnBar - breakdownStart);
      return x < 0.5 ? 16000 * (1400 / 16000) ** (x * 2) : 1400 * (16000 / 1400) ** ((x - 0.5) * 2);
    }
    return 16000;
  };
  for (const s of [keys, pads, plucks]) {
    const fl = new Biquad('lp', 16000);
    const fr = new Biquad('lp', 16000);
    for (let i = 0; i < n; i++) {
      if (i % 128 === 0) {
        const c = cutoff(i / SR);
        fl.set('lp', c);
        fr.set('lp', c);
      }
      s.L[i] = fl.run(s.L[i]);
      s.R[i] = fr.run(s.R[i]);
    }
  }

  // The kick pushes the pad and bass down a little.
  const duck = new Float32Array(n).fill(1);
  for (const kt of kickTimes) {
    const i0 = Math.round(kt * SR);
    for (let i = 0; i < 0.3 * SR && i0 + i < n; i++) duck[i0 + i] = Math.min(duck[i0 + i], 1 - 0.35 * Math.exp(-i / (0.09 * SR)));
  }
  for (const s of [pads, low]) {
    for (let i = 0; i < n; i++) {
      s.L[i] *= duck[i];
      s.R[i] *= duck[i];
    }
  }

  const noise = stereo(n);
  vinyl(noise, rng);

  levelTo(kicks, -17);
  levelTo(low, -19);
  levelTo(snares, -24);
  levelTo(hats, -31);
  levelTo(keys, -20);
  levelTo(pads, -27);
  levelTo(plucks, -27);
  levelTo(fx, -25);
  levelTo(noise, -46);

  const master = stereo(n);
  for (const s of [kicks, low, snares, hats, keys, pads, plucks, fx, noise]) mixInto(master, s);

  const send = stereo(n);
  mixInto(send, keys, 0.35);
  mixInto(send, pads, 0.4);
  mixInto(send, plucks, 0.3);
  mixInto(send, snares, 0.3);
  mixInto(master, reverb(send, 0.86, 0.35), 1);
  mixInto(master, pingPong(plucks, (tl.barMs / 1000 / 16) * 3, 0.38), 0.45);

  saturateAndFade(master, tl.durationMs / 1000);
  return master;
}

/** Gentle saturation, then the fades. */
function saturateAndFade(s: Stereo, durationSec: number): void {
  const pre = 0.8 / Math.max(1e-6, peak(s));
  for (let i = 0; i < s.L.length; i++) {
    s.L[i] = Math.tanh(s.L[i] * pre * 1.2);
    s.R[i] = Math.tanh(s.R[i] * pre * 1.2);
  }
  fadeEnds(s, durationSec);
}

/** A short fade in, a fade out over the last 1.8 s, peak at -1 dBFS. */
function fadeEnds(s: Stereo, durationSec: number): void {
  const fadeIn = Math.round(0.02 * SR);
  const fadeOut = Math.round(1.8 * SR);
  const n = Math.min(s.L.length, Math.round(durationSec * SR));
  for (let i = 0; i < n; i++) {
    let g = 1;
    if (i < fadeIn) g = i / fadeIn;
    if (i > n - fadeOut) g *= 0.5 + 0.5 * Math.cos((Math.PI * (i - (n - fadeOut))) / fadeOut);
    s.L[i] *= g;
    s.R[i] *= g;
  }
  const g = dbToGain(-1) / Math.max(1e-6, peak(s));
  for (let i = 0; i < s.L.length; i++) {
    s.L[i] *= g;
    s.R[i] *= g;
  }
}

/* ───────── Interface sounds ───────── */

function tone(out: Stereo, t0: number, f0: number, f1: number, dur: number, decay: number, amp: number, pan = 0): void {
  const n0 = Math.round(t0 * SR);
  const len = Math.round(dur * SR);
  const [gl, gr] = panGains(pan);
  let ph = 0;
  for (let i = 0; i < len; i++) {
    const n = n0 + i;
    if (n >= out.L.length) break;
    const t = i / SR;
    const f = f0 * (f1 / f0) ** Math.min(1, t / Math.max(1e-3, dur * 0.6));
    ph += (TAU * f) / SR;
    const y = Math.sin(ph) * Math.min(1, t / 0.002) * Math.exp(-t / decay) * amp;
    out.L[n] += y * gl;
    out.R[n] += y * gr;
  }
}

function noiseBurst(out: Stereo, t0: number, f: number, q: number, dur: number, decay: number, amp: number, rng: Rng, pan = 0): void {
  const n0 = Math.round(t0 * SR);
  const len = Math.round(dur * SR);
  const bp = new Biquad('bp', f, q);
  const [gl, gr] = panGains(pan);
  for (let i = 0; i < len; i++) {
    const n = n0 + i;
    if (n >= out.L.length) break;
    const t = i / SR;
    const y = bp.run(rng.bi()) * Math.exp(-t / decay) * amp;
    out.L[n] += y * gl;
    out.R[n] += y * gr;
  }
}

function whoosh(out: Stereo, t0: number, rng: Rng): void {
  const n0 = Math.round(t0 * SR);
  const dur = 0.32;
  const len = Math.round(dur * SR);
  const bp = new Biquad('bp', 350, 0.9);
  for (let i = 0; i < len; i++) {
    const n = n0 + i;
    if (n >= out.L.length) break;
    const x = i / len;
    if (i % 32 === 0) bp.set('bp', 350 * (2400 / 350) ** x, 0.9);
    const y = bp.run(rng.bi()) * Math.sin(Math.PI * x) ** 2 * 0.9;
    out.L[n] += y * (1 - 0.4 * x);
    out.R[n] += y * (0.6 + 0.4 * x);
  }
}

export function composeSfx(cues: Cue[], durationMs: number): Stereo {
  const n = Math.ceil((durationMs / 1000) * SR);
  const out = stereo(n);
  const rng = new Rng(11);
  for (const c of cues) {
    const t = c.t / 1000;
    switch (c.type) {
      case 'click':
        noiseBurst(out, t, 3600, 1.4, 0.03, 0.004, 1.4, rng);
        tone(out, t, 1900, 1500, 0.05, 0.012, 0.5);
        break;
      case 'key': {
        const pan = rng.range(-0.2, 0.2);
        noiseBurst(out, t, rng.range(2600, 4200), 1.6, 0.025, 0.003, rng.range(0.5, 0.8), rng, pan);
        tone(out, t, rng.range(1200, 1600), 1100, 0.03, 0.006, 0.18, pan);
        break;
      }
      case 'send':
        tone(out, t, 520, 1080, 0.18, 0.06, 0.6);
        tone(out, t + 0.012, 1040, 2160, 0.14, 0.04, 0.18);
        break;
      case 'receive':
        tone(out, t, 1180, 720, 0.2, 0.07, 0.55);
        tone(out, t + 0.07, 1480, 1100, 0.2, 0.06, 0.3);
        break;
      case 'pop':
        tone(out, t, 880, 1320, 0.1, 0.04, 0.5);
        break;
      case 'alert':
        tone(out, t, 1318.5, 1318.5, 0.7, 0.28, 0.5);
        tone(out, t, 3955, 3955, 0.3, 0.06, 0.08);
        tone(out, t + 0.12, 987.8, 987.8, 0.9, 0.35, 0.5);
        tone(out, t + 0.12, 2963, 2963, 0.3, 0.06, 0.07);
        break;
      case 'confirm':
        tone(out, t, 1568, 1568, 0.2, 0.06, 0.35);
        tone(out, t + 0.07, 2093, 2093, 0.3, 0.09, 0.35);
        break;
      case 'notify':
        tone(out, t, 1760, 1760, 1.4, 0.5, 0.22);
        tone(out, t, 2637, 2637, 1, 0.3, 0.1);
        tone(out, t, 4400, 4400, 0.5, 0.1, 0.03);
        break;
      case 'whoosh':
        whoosh(out, t, rng);
        break;
      case 'tick':
        tone(out, t, 1650, 1650, 0.05, 0.012, 0.35);
        noiseBurst(out, t, 5000, 1.2, 0.02, 0.003, 0.6, rng);
        break;
    }
  }
  const send = stereo(n);
  mixInto(send, out, 0.25);
  mixInto(out, reverb(send, 0.55, 0.45));
  return out;
}

/* ───────── Files ───────── */

export function writeWav(path: string, s: Stereo): void {
  const n = s.L.length;
  const data = Buffer.alloc(n * 8);
  for (let i = 0; i < n; i++) {
    data.writeFloatLE(s.L[i], i * 8);
    data.writeFloatLE(s.R[i], i * 8 + 4);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8);
  head.write('fmt ', 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(3, 20); // IEEE float
  head.writeUInt16LE(2, 22);
  head.writeUInt32LE(SR, 24);
  head.writeUInt32LE(SR * 8, 28);
  head.writeUInt16LE(8, 32);
  head.writeUInt16LE(32, 34);
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([head, data]));
}

/** Decode any track ffmpeg reads, trimmed to the film with a fade at each end. */
export function loadMusic(file: string, durationMs: number): Stereo {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'f32le', '-ac', '2', '-ar', String(SR), '-'], {
    maxBuffer: 1 << 30
  });
  const f = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const n = Math.ceil((durationMs / 1000) * SR);
  const s = stereo(n);
  for (let i = 0; i < n && i * 2 + 1 < f.length; i++) {
    s.L[i] = f[i * 2];
    s.R[i] = f[i * 2 + 1];
  }
  fadeEnds(s, durationMs / 1000);
  return s;
}

export function mixdown(music: Stereo, sfx: Stereo, sfxDb: number): Stereo {
  const out = stereo(music.L.length);
  mixInto(out, music);
  levelTo(sfx, sfxDb);
  mixInto(out, sfx);
  const p = peak(out);
  if (p > 0.99) {
    const g = 0.99 / p;
    for (let i = 0; i < out.L.length; i++) {
      out.L[i] *= g;
      out.R[i] *= g;
    }
  }
  return out;
}

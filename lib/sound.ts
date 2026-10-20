"use client";

import { LAND_HOLD_MS, SHRINK_MS } from "./game";

/**
 * Small sounds synthesized with Web Audio, no audio files: a soft sine boop
 * per finger, a tone swelling up to the pick, and an airy whoosh as the
 * losers vanish.
 */

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
/** The running countdown swell, routed through its own gain so it can be cut off. */
let swell: GainNode | null = null;

/** Starts audio. Must run inside a touch or click: browsers only allow sound after a user gesture. */
export function unlockAudio() {
  if (typeof window === "undefined") return;
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    // Play through the iPhone's silent switch: iPhones can't vibrate from the web, so sound is all they get.
    const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
    if (session) session.type = "playback";
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
  }
  if (ctx.state !== "running") ctx.resume().catch(() => {});
}

// A3, D4, E4, A4: each new finger steps up, then wraps around.
const TOUCH_NOTES = [220, 293.66, 329.63, 440];

/** A soft, round boop as a finger goes down; `n` is how many fingers this device now holds. */
export function playTouch(n: number) {
  if (!ctx || !master) return;
  const at = ctx.currentTime;
  const freq = TOUCH_NOTES[(Math.max(n, 1) - 1) % TOUCH_NOTES.length];
  // A faint third harmonic so the low notes still carry on a phone speaker.
  for (const [mult, level] of [[1, 0.3], [3, 0.013]]) {
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.frequency.value = freq * mult;
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(level, at + 0.09);
    env.gain.setValueAtTime(level, at + 0.15);
    env.gain.exponentialRampToValueAtTime(level * 0.01, at + 0.55);
    env.gain.linearRampToValueAtTime(0, at + 0.6);
    osc.connect(env).connect(master);
    osc.start(at);
    osc.stop(at + 0.62);
  }
}

// Partials of the swell: [harmonic, level at the start, level at the end]. It brightens as it grows.
const SWELL_PARTIALS = [
  [1, 1, 1],
  [2, 0.13, 0.5],
  [3, 0.005, 0.022],
  [4, 0.004, 0.02],
];

/** How long before the pick the swell starts. */
const SWELL_MS = 850;

/**
 * A steady A4 that swells louder and brighter over the last moments before
 * `endsAt` (room clock), then stops dead as the winner is picked. Replaces any
 * countdown already playing.
 */
export function startCountdown(endsAt: number, roomNow: number) {
  stopCountdown();
  if (!ctx || !master) return;
  const end = ctx.currentTime + (endsAt - roomNow) / 1000;
  if (end <= ctx.currentTime) return;
  const begin = end - SWELL_MS / 1000;
  swell = ctx.createGain();
  swell.connect(master);
  // Rises evenly in loudness, about 24 dB up to full.
  swell.gain.setValueAtTime(0.02, begin);
  swell.gain.exponentialRampToValueAtTime(0.32, end);
  swell.gain.setValueAtTime(0.32, end);
  swell.gain.linearRampToValueAtTime(0, end + 0.04);
  for (const [mult, from, to] of SWELL_PARTIALS) {
    const osc = ctx.createOscillator();
    const level = ctx.createGain();
    osc.frequency.value = 440 * mult;
    level.gain.setValueAtTime(from, begin);
    level.gain.exponentialRampToValueAtTime(to, end);
    osc.connect(level).connect(swell);
    osc.start(Math.max(begin, ctx.currentTime));
    osc.stop(end + 0.1);
  }
}

/** Cuts off the countdown swell, e.g. when a finger lifts before it ends. */
export function stopCountdown() {
  if (!ctx || !swell) return;
  const g = swell;
  swell = null;
  g.gain.cancelScheduledValues(ctx.currentTime);
  g.gain.setTargetAtTime(0, ctx.currentTime, 0.015);
  setTimeout(() => g.disconnect(), 300);
}

/**
 * An airy, high whoosh for the device holding a winning finger, as the losers
 * finish shrinking away after the reveal lands at `landAt` (room clock).
 */
export function playWin(landAt: number, roomNow: number) {
  if (!ctx || !master) return;
  const at = ctx.currentTime + Math.max(0, (landAt + LAND_HOLD_MS + SHRINK_MS - roomNow) / 1000);
  const length = 0.4;
  const noise = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * length), ctx.sampleRate);
  const data = noise.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

  const src = ctx.createBufferSource();
  src.buffer = noise;
  const band = ctx.createBiquadFilter();
  band.type = "bandpass";
  band.Q.value = 1.4;
  band.frequency.setValueAtTime(6500, at);
  band.frequency.exponentialRampToValueAtTime(8500, at + 0.3);
  const env = ctx.createGain();
  env.gain.setValueAtTime(0.002, at);
  env.gain.exponentialRampToValueAtTime(0.45, at + 0.25);
  env.gain.setValueAtTime(0.45, at + 0.29);
  env.gain.linearRampToValueAtTime(0, at + 0.37);
  src.connect(band).connect(env).connect(master);
  src.start(at);
  src.stop(at + length);
}

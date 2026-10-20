"use client";

import {
  ALONE_MS,
  COUNTDOWN_MS,
  FLOOD_HOLD_MS,
  FLOOD_MS,
  FingerKey,
  LAND_HOLD_MS,
  RING_FILL_DELAY_MS,
  RING_FILL_MS,
  SHRINK_MS,
  Snapshot,
  UNFLOOD_MS,
  paletteColor,
} from "./game";

export interface DrawnFinger {
  key: FingerKey;
  x: number;
  y: number;
  /** Local time the finger got its color (start of the grow-in). */
  bornAt: number;
  /** Palette index once the room gave this finger a color; kept so it can shrink out after losing it. */
  colorIndex: number | null;
  /** Local time the finger was lifted outside a reveal (start of the shrink-out). */
  goneAt: number | null;
}

export interface Frame {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  localNow: number;
  roomNow: number;
  snap: Snapshot;
  fingers: DrawnFinger[];
}

const BG = "#0d0d0d";
const CORE_R = 34;
const RING_R = 50;
const RING_W = 7;
const TOP = -Math.PI / 2;
const WINNER_SCALE = 1.08;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const easeOutBack = (t: number) => 1 + 2.4 * Math.pow(t - 1, 3) + 1.4 * Math.pow(t - 1, 2);
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeIn = (t: number) => t * t;

export function draw(f: Frame) {
  const { ctx, width, height, snap } = f;
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, width, height);

  const reveal = snap.reveal;
  if (!reveal) {
    const elapsed = snap.countdownEndsAt === null ? 0 : f.roomNow - (snap.countdownEndsAt - COUNTDOWN_MS);
    const fill = snap.countdownEndsAt === null ? 0 : clamp01((elapsed - RING_FILL_DELAY_MS) / RING_FILL_MS);
    for (const finger of f.fingers) {
      const index = snap.colors[finger.key] ?? finger.colorIndex;
      if (index === undefined || index === null) continue;
      drawFinger(ctx, finger, paletteColor(index), {
        scale: growScale(f.localNow, finger),
        fill: finger.goneAt === null ? fill : 0,
        now: f.localNow,
        lit: 0,
      });
    }
    return;
  }

  const t = f.roomNow;
  const shrinkAt = reveal.landAt + LAND_HOLD_MS;
  const floodAt = shrinkAt + SHRINK_MS + ALONE_MS;
  const winners = new Set(reveal.winners);

  const landed = t >= reveal.landAt;
  const pop = easeOutBack(clamp01((t - reveal.landAt) / 320));

  const visible = f.fingers.filter((finger) => snap.colors[finger.key] !== undefined);

  // The winner lights up and grows a touch; everyone else shrinks away.
  for (const finger of visible) {
    const isWinner = winners.has(finger.key);
    let scale = 1;
    if (landed) scale = isWinner ? 1 + (WINNER_SCALE - 1) * pop : 1 - easeIn(clamp01((t - shrinkAt) / SHRINK_MS));
    if (scale <= 0.01) continue;
    drawFinger(ctx, finger, paletteColor(snap.colors[finger.key]), {
      scale,
      fill: 1,
      now: f.localNow,
      lit: landed && isWinner ? 1 : 0,
    });
  }

  if (reveal.winners.length !== 1 || t < floodAt) return;

  // One winner: their color floods in from the edges of every screen, closing
  // down to a dark well around the winning finger on its own device, holds,
  // then pulls back out to black.
  const unfloodAt = floodAt + FLOOD_MS + FLOOD_HOLD_MS;
  if (t >= unfloodAt + UNFLOOD_MS) return;
  const winnerKey = reveal.winners[0];
  const color = paletteColor(snap.colors[winnerKey] ?? 0);
  const local = visible.find((finger) => finger.key === winnerKey);
  const cx = local ? local.x : width / 2;
  const cy = local ? local.y : height / 2;
  const far = Math.hypot(Math.max(cx, width - cx), Math.max(cy, height - cy)) + 4;
  const finalR = local ? RING_R * WINNER_SCALE + 26 : 0;
  const k =
    t < unfloodAt
      ? easeInOut(clamp01((t - floodAt) / FLOOD_MS))
      : 1 - easeInOut(clamp01((t - unfloodAt) / UNFLOOD_MS));
  const holeR = far + (finalR - far) * k;

  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.rect(0, 0, width, height);
  if (holeR > 0.5) ctx.arc(cx, cy, holeR, 0, Math.PI * 2);
  ctx.fill("evenodd");
  ctx.restore();

  if (local) {
    drawFinger(ctx, local, color, { scale: WINNER_SCALE, fill: 1, now: f.localNow, lit: 1 });
  }
}

function growScale(now: number, finger: DrawnFinger) {
  if (finger.goneAt !== null) return 1 - easeIn(clamp01((now - finger.goneAt) / 220));
  return easeOutBack(clamp01((now - finger.bornAt) / 420));
}

interface Look {
  scale: number;
  /** 0..1: how far the countdown's bright arc has drawn around the ring. */
  fill: number;
  now: number;
  /** 1 when the light is on this finger. */
  lit: number;
}

function drawFinger(ctx: CanvasRenderingContext2D, finger: DrawnFinger, color: string, look: Look) {
  if (look.scale <= 0.01) return;
  const { x, y } = finger;
  const s = look.scale;
  const age = look.now - finger.bornAt;

  ctx.save();

  // Core dot.
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, CORE_R * s, 0, Math.PI * 2);
  ctx.fill();

  // Ring: draws in counterclockwise from the top when the finger lands, in a
  // darker shade of the core, then sits still.
  const sweep = Math.min(1, age / 650) * Math.PI * 2;
  const ringR = (RING_R + look.lit * 4) * s;
  ctx.lineCap = "round";
  ctx.lineWidth = RING_W * s;
  ctx.strokeStyle = mix(color, "#000000", 0.35);
  ctx.beginPath();
  ctx.arc(x, y, ringR, TOP, TOP - sweep, true);
  ctx.stroke();

  // Countdown: a bright arc draws once around the ring, clockwise from the top.
  if (look.fill > 0) {
    ctx.strokeStyle = mix(color, "#ffffff", look.lit ? 0.55 : 0.45);
    ctx.beginPath();
    ctx.arc(x, y, ringR, TOP, TOP + look.fill * Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

const parsed = new Map<string, [number, number, number]>();

function toRgb(color: string): [number, number, number] {
  const hit = parsed.get(color);
  if (hit) return hit;
  let rgb: [number, number, number] = [255, 255, 255];
  if (color.startsWith("#")) {
    const n = parseInt(color.slice(1), 16);
    rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  } else {
    const m = color.match(/hsl\((\d+)\s+(\d+)%\s+(\d+)%\)/);
    if (m) rgb = hslToRgb(+m[1], +m[2] / 100, +m[3] / 100);
  }
  parsed.set(color, rgb);
  return rgb;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

function mix(a: string, b: string, amount: number): string {
  const x = toRgb(a);
  const y = toRgb(b);
  const c = x.map((v, i) => Math.round(v + (y[i] - v) * amount));
  return `rgb(${c[0]} ${c[1]} ${c[2]})`;
}

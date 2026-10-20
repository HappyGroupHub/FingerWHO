// Shared types, timing constants and colors used by both the room logic
// (server or in-browser) and the renderer.

/** A finger anywhere in the room: `${deviceId}:${touchId}`. */
export type FingerKey = string;

export type Phase = "idle" | "countdown" | "reveal";

export interface Reveal {
  /** Room-clock time (ms) when the winners light up on every device. */
  landAt: number;
  winners: FingerKey[];
}

export interface Snapshot {
  phase: Phase;
  winners: number;
  devices: number;
  /** Palette index for every finger that takes part in the current round. */
  colors: Record<FingerKey, number>;
  countdownEndsAt: number | null;
  reveal: Reveal | null;
}

export type ClientMsg =
  | { t: "touches"; ids: string[] }
  | { t: "winners"; n: number }
  | { t: "ping"; c: number };

export type ServerMsg =
  | { t: "state"; s: Snapshot }
  | { t: "pong"; c: number; s: number };

export const COUNTDOWN_MS = 3000;
/** Time between the server deciding and the reveal starting, so every device has the message in hand. */
export const REVEAL_LEAD_MS = 350;
/** After the winner pops: losers shrink, the winner's color floods the screen, holds, then pulls back. */
export const LAND_HOLD_MS = 250;
export const SHRINK_MS = 350;
export const FLOOD_MS = 750;
export const FLOOD_HOLD_MS = 1500;
export const UNFLOOD_MS = 650;
export const MAX_WINNERS = 9;

export const minFingers = (winners: number) => Math.max(2, winners + 1);

export const revealEnd = (r: Reveal) => r.landAt + LAND_HOLD_MS + SHRINK_MS + FLOOD_MS + FLOOD_HOLD_MS + UNFLOOD_MS;

export const keyOf = (deviceId: string, touchId: string): FingerKey => `${deviceId}:${touchId}`;

// Hand-picked colors that stay distinct on black, in the order they are handed out.
const PALETTE = [
  "#7DB928", // green
  "#FF6E00", // orange
  "#E0309F", // magenta
  "#22C3E6", // cyan
  "#F5D84A", // yellow
  "#E2E2E2", // white
  "#4166FF", // blue
  "#F0303A", // red
  "#9B4DFF", // purple
  "#16C79A", // teal
  "#FF94BE", // pink
  "#C6F03C", // lime
  "#C8902E", // amber
  "#8FD3FF", // sky
  "#FF8A5C", // coral
  "#6A4CC8", // indigo
];

export function paletteColor(index: number): string {
  if (index < PALETTE.length) return PALETTE[index];
  // Past the palette, spread hues by the golden angle so neighbours never clash.
  const hue = Math.round((index * 137.508) % 360);
  return `hsl(${hue} 80% 58%)`;
}

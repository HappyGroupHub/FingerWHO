import {
  COUNTDOWN_MS,
  FingerKey,
  MAX_WINNERS,
  Phase,
  Reveal,
  Snapshot,
  keyOf,
  minFingers,
  revealEnd,
} from "./game";

export interface RoomDeps {
  now: () => number;
  broadcast: (s: Snapshot) => void;
  /** Delay before the reveal starts; the server leaves time for the message to arrive. */
  revealLead: number;
  random?: () => number;
}

/**
 * The single source of truth for one round: which fingers are down on which
 * device, their colors, the countdown and the result. Runs on the server for
 * multi-device rooms and inside the browser for solo play.
 */
export class Room {
  private touches = new Map<string, string[]>();
  private colors: Record<FingerKey, number> = {};
  private phase: Phase = "idle";
  private winners = 1;
  private countdownEndsAt: number | null = null;
  private reveal: Reveal | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Fingers from the last round still held down; they sit out until lifted and placed again. */
  private spent = new Set<FingerKey>();
  private random: () => number;

  constructor(private deps: RoomDeps) {
    this.random = deps.random ?? Math.random;
  }

  get deviceCount() {
    return this.touches.size;
  }

  addDevice(deviceId: string) {
    if (!this.touches.has(deviceId)) this.touches.set(deviceId, []);
    this.emit();
  }

  removeDevice(deviceId: string) {
    this.setTouches(deviceId, []);
    this.touches.delete(deviceId);
    this.emit();
  }

  setWinners(n: number) {
    if (this.phase === "reveal") return;
    this.winners = Math.min(MAX_WINNERS, Math.max(1, Math.round(n)));
    this.restartCountdown();
    this.emit();
  }

  setTouches(deviceId: string, ids: string[]) {
    this.touches.set(deviceId, [...new Set(ids)]);
    const current = new Set(this.currentKeys());
    for (const key of this.spent) if (!current.has(key)) this.spent.delete(key);

    // Fingers that join mid-reveal wait for the round to end on its own timer.
    if (this.phase === "reveal") return;

    if (this.syncColors()) this.restartCountdown();
    this.emit();
  }

  snapshot(): Snapshot {
    return {
      phase: this.phase,
      winners: this.winners,
      devices: this.touches.size,
      colors: { ...this.colors },
      countdownEndsAt: this.countdownEndsAt,
      reveal: this.reveal,
    };
  }

  dispose() {
    this.clearTimer();
  }

  private currentKeys(): FingerKey[] {
    const keys: FingerKey[] = [];
    for (const [deviceId, ids] of this.touches) for (const id of ids) keys.push(keyOf(deviceId, id));
    return keys;
  }

  /** Gives new fingers a color and frees lifted ones. Returns whether anything changed. */
  private syncColors(): boolean {
    const current = new Set(this.currentKeys().filter((key) => !this.spent.has(key)));
    let changed = false;
    for (const key of Object.keys(this.colors)) {
      if (!current.has(key)) {
        delete this.colors[key];
        changed = true;
      }
    }
    const used = new Set(Object.values(this.colors));
    for (const key of current) {
      if (key in this.colors) continue;
      let index = 0;
      while (used.has(index)) index++;
      used.add(index);
      this.colors[key] = index;
      changed = true;
    }
    return changed;
  }

  private restartCountdown() {
    this.clearTimer();
    const count = Object.keys(this.colors).length;
    if (count >= minFingers(this.winners)) {
      this.phase = "countdown";
      this.countdownEndsAt = this.deps.now() + COUNTDOWN_MS;
      // Decide a little early so the result reaches every device by the time the countdown runs out.
      this.timer = setTimeout(() => this.startReveal(), COUNTDOWN_MS - this.deps.revealLead);
    } else {
      this.phase = "idle";
      this.countdownEndsAt = null;
    }
  }

  private startReveal() {
    this.timer = null;
    const keys = Object.keys(this.colors);
    const winners = shuffle(keys, this.random).slice(0, this.winners);
    const landAt = this.countdownEndsAt ?? this.deps.now() + this.deps.revealLead;

    this.phase = "reveal";
    this.countdownEndsAt = null;
    this.reveal = { landAt, winners };
    this.timer = setTimeout(() => this.finishReveal(), revealEnd(this.reveal) - this.deps.now());
    this.emit();
  }

  /**
   * The round always ends when the animation does, without waiting for anyone
   * to lift a finger: one person still holding on, or a phone that dropped a
   * touch event, must never lock everyone else out.
   */
  private finishReveal() {
    this.timer = null;
    const current = new Set(this.currentKeys());
    this.spent = new Set(Object.keys(this.colors).filter((key) => current.has(key)));
    this.reveal = null;
    this.colors = {};
    this.phase = "idle";
    // Fingers that were put down during the reveal start the next round.
    this.syncColors();
    this.restartCountdown();
    this.emit();
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private emit() {
    this.deps.broadcast(this.snapshot());
  }
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

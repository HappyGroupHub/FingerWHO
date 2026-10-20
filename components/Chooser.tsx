"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { MAX_WINNERS, Snapshot, keyOf, minFingers } from "@/lib/game";
import { haptic } from "@/lib/haptics";
import { DrawnFinger, draw } from "@/lib/render";
import { onAudioChange, playTouch, playWin, startCountdown, stopCountdown, unlockAudio } from "@/lib/sound";
import { ConnectionStatus, Transport, createTransport, newRoomCode } from "@/lib/transport";
import styles from "./chooser.module.css";

interface Finger extends DrawnFinger {
  id: string;
  /** Lifted during a reveal: stays on screen, frozen, until the round ends. */
  lifted: boolean;
  /** Still held when its round ended: sits out until lifted and placed again. */
  spent: boolean;
}

/** A room nobody has touched for this long is over; reopening the page starts solo again. */
const ROOM_IDLE_MS = 30 * 60 * 1000;

const EMPTY: Snapshot = { phase: "idle", winners: 1, devices: 1, colors: {}, countdownEndsAt: null, reveal: null };

export default function Chooser() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const transportRef = useRef<Transport | null>(null);
  const snapRef = useRef<Snapshot>(EMPTY);
  const fingersRef = useRef(new Map<string, Finger>());
  const mouseSeq = useRef(0);
  const roomRef = useRef<string | null>(null);

  const [snap, setSnap] = useState<Snapshot>(EMPTY);
  const [status, setStatus] = useState<ConnectionStatus>("solo");
  const [room, setRoom] = useState<string | null>(null);
  const [localCount, setLocalCount] = useState(0);
  const [spentCount, setSpentCount] = useState(0);
  const [panel, setPanel] = useState<"none" | "winners" | "devices">("none");
  const [qr, setQr] = useState<{ room: string; src: string } | null>(null);
  const [copied, setCopied] = useState<"no" | "yes" | "failed">("no");
  const [soundOn, setSoundOn] = useState(false);

  const sendTouches = useCallback(() => {
    const held = [...fingersRef.current.values()].filter((f) => !f.lifted && f.goneAt === null);
    const ids = held.filter((f) => !f.spent).map((f) => f.id);
    setLocalCount(ids.length);
    if (ids.length > 0) touchRoom(roomRef.current);
    setSpentCount(held.length - ids.length);
    transportRef.current?.send({ t: "touches", ids });
  }, []);

  const onSnapshot = useCallback((s: Snapshot) => {
    const prev = snapRef.current;
    snapRef.current = s;
    setSnap(s);
    const now = Date.now();
    const deviceId = transportRef.current?.deviceId ?? "";
    const roomNow = transportRef.current?.roomNow() ?? now;
    // Deferred: snapshots can arrive from inside the room's own update.
    if (syncFingers(fingersRef.current, prev, s, deviceId, now)) queueMicrotask(sendTouches);
    if (s.countdownEndsAt !== prev.countdownEndsAt) {
      if (s.countdownEndsAt !== null) startCountdown(s.countdownEndsAt, roomNow);
      // The reveal is decided just before the countdown ends: let its last ticks play out.
      else if (!s.reveal) stopCountdown();
    }
    if (!prev.reveal && s.reveal) scheduleReveal(s, deviceId, roomNow);
  }, [sendTouches]);

  // One transport for the page's lifetime; join the room in the URL if there is one.
  useEffect(() => {
    const transport = createTransport({ onSnapshot, onStatus: setStatus });
    transportRef.current = transport;
    const code = new URLSearchParams(location.search).get("r");
    if (code && roomExpired(code.toUpperCase())) {
      // A tab reopened long after its round: the link is stale, start fresh.
      history.replaceState(null, "", "/");
    } else if (code && /^[A-Za-z0-9]{4,8}$/.test(code)) {
      // The room code lives in the URL, outside React; mirror it once on load.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRoom(code.toUpperCase());
      transport.joinRoom(code.toUpperCase());
      touchRoom(code.toUpperCase());
    }
    return () => transport.close();
  }, [onSnapshot]);

  const leaveRoom = useCallback(() => {
    history.replaceState(null, "", "/");
    setRoom(null);
    transportRef.current?.leaveRoom();
    setPanel("none");
  }, []);

  // Coming back to a tab whose room went quiet long ago leaves that room.
  useEffect(() => {
    roomRef.current = room;
    if (!room) return;
    const onVisible = () => {
      if (document.visibilityState === "visible" && roomExpired(room)) leaveRoom();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [room, leaveRoom]);

  useEffect(() => {
    if (!room) return;
    const url = `${location.origin}/?r=${room}`;
    QRCode.toDataURL(url, { margin: 1, width: 480, color: { dark: "#0d0d0d", light: "#ffffff" } }).then((src) =>
      setQr({ room, src }),
    );
  }, [room]);

  // Sound only starts from a gesture the browser trusts (on iPhones, a quick tap),
  // so listen for one anywhere on the page, buttons included.
  useEffect(() => {
    const events = ["touchend", "pointerup", "click", "keydown"] as const;
    for (const type of events) document.addEventListener(type, unlockAudio, { capture: true, passive: true });
    const off = onAudioChange(setSoundOn);
    return () => {
      for (const type of events) document.removeEventListener(type, unlockAudio, { capture: true });
      off();
    };
  }, []);

  // Touch input.
  useEffect(() => {
    const canvas = canvasRef.current!;
    const fingers = fingersRef.current;
    const inReveal = () => snapRef.current.phase === "reveal";

    const add = (id: string, x: number, y: number) => {
      fingers.set(id, { id, key: keyOf(transportRef.current?.deviceId ?? "", id), x, y, bornAt: Date.now(), colorIndex: null, goneAt: null, lifted: false, spent: false });
      const index = snapRef.current.colors[keyOf(transportRef.current?.deviceId ?? "", id)];
      if (index !== undefined) fingers.get(id)!.colorIndex = index;
    };
    const remove = (id: string) => {
      const f = fingers.get(id);
      if (!f) return;
      if (f.spent) {
        fingers.delete(id);
      } else if (inReveal() && f.colorIndex !== null) {
        f.lifted = true;
      } else if (f.colorIndex !== null) {
        f.goneAt = Date.now();
        setTimeout(() => fingers.get(id) === f && fingers.delete(id), 260);
      } else {
        fingers.delete(id);
      }
    };

    const onTouchStart = (e: TouchEvent) => {
      e.preventDefault();
      setPanel("none");
      requestWakeLock();
      unlockAudio();
      for (const t of e.changedTouches) add(String(t.identifier), t.clientX, t.clientY);
      haptic(10);
      playTouch(e.touches.length);
      sendTouches();
    };
    const onTouchMove = (e: TouchEvent) => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        const f = fingers.get(String(t.identifier));
        if (f && !f.lifted) {
          f.x = t.clientX;
          f.y = t.clientY;
        }
      }
    };
    const onTouchEnd = (e: TouchEvent) => {
      e.preventDefault();
      for (const t of e.changedTouches) remove(String(t.identifier));
      sendTouches();
    };

    // With a mouse, each click pins a pretend finger; clicking it again lifts it.
    const onMouseDown = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      setPanel("none");
      const hit = [...fingers.values()].find((f) => f.id.startsWith("m") && !f.lifted && f.goneAt === null && Math.hypot(f.x - e.clientX, f.y - e.clientY) < 50);
      unlockAudio();
      if (hit) {
        remove(hit.id);
      } else {
        add(`m${++mouseSeq.current}`, e.clientX, e.clientY);
        playTouch([...fingers.values()].filter((f) => f.id.startsWith("m") && !f.lifted && f.goneAt === null).length);
      }
      sendTouches();
    };

    // A phone that locks or switches apps never reports its fingers lifting; let them go now.
    const onHidden = () => {
      if (document.visibilityState !== "hidden" || fingers.size === 0) return;
      fingers.clear();
      sendTouches();
    };

    const opts = { passive: false } as const;
    document.addEventListener("visibilitychange", onHidden);
    canvas.addEventListener("touchstart", onTouchStart, opts);
    canvas.addEventListener("touchmove", onTouchMove, opts);
    canvas.addEventListener("touchend", onTouchEnd, opts);
    canvas.addEventListener("touchcancel", onTouchEnd, opts);
    canvas.addEventListener("pointerdown", onMouseDown);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      canvas.removeEventListener("touchstart", onTouchStart);
      canvas.removeEventListener("touchmove", onTouchMove);
      canvas.removeEventListener("touchend", onTouchEnd);
      canvas.removeEventListener("touchcancel", onTouchEnd);
      canvas.removeEventListener("pointerdown", onMouseDown);
    };
  }, [sendTouches]);

  // Render loop.
  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    let width = 0;
    let height = 0;
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);
    let raf = 0;
    const frame = () => {
      draw({
        ctx,
        width,
        height,
        localNow: Date.now(),
        roomNow: transportRef.current?.roomNow() ?? Date.now(),
        snap: snapRef.current,
        fingers: [...fingersRef.current.values()],
      });
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  const setWinners = (n: number) => {
    const next = Math.min(MAX_WINNERS, Math.max(1, n));
    transportRef.current?.send({ t: "winners", n: next });
  };

  // Opening the panel opens the room right away; this device keeps working on its own until others join.
  const openDevices = () => {
    if (!room) {
      const code = newRoomCode();
      history.replaceState(null, "", `/?r=${code}`);
      setRoom(code);
      transportRef.current?.joinRoom(code);
      touchRoom(code);
      transportRef.current?.send({ t: "winners", n: snapRef.current.winners });
    }
    setCopied("no");
    setPanel("devices");
  };

  const copyLink = async () => {
    if (!room) return;
    const ok = await copyText(`${location.origin}/?r=${room}`);
    setCopied(ok ? "yes" : "failed");
    if (ok) setTimeout(() => setCopied((c) => (c === "yes" ? "no" : c)), 2000);
  };

  const total = Object.keys(snap.colors).length;
  const busy = snap.phase !== "idle" || localCount > 0 || spentCount > 0;
  const need = minFingers(snap.winners);
  // Only talk about "all devices" once another device is actually here.
  const shared = status === "online" && snap.devices > 1;
  const isLocalhost = typeof location !== "undefined" && /^(localhost|127\.|\[::1\])/.test(location.hostname);

  return (
    <main className={styles.root} data-phase={snap.phase} data-status={status}>
      <canvas ref={canvasRef} className={styles.canvas} />

      <div className={`${styles.chrome} ${busy ? styles.hidden : ""}`}>
        <button className={styles.winnersBtn} onClick={() => setPanel(panel === "winners" ? "none" : "winners")} aria-label="選幾人">
          <span className={styles.big}>{snap.winners}</span>
          <span className={styles.small}>人</span>
        </button>
        <button className={styles.devicesBtn} onClick={() => (panel === "devices" ? setPanel("none") : openDevices())} aria-label="新增裝置">
          <PhonesIcon />
          {room && status === "online" && <span className={styles.badge}>{snap.devices}</span>}
          {room && status === "connecting" && <span className={`${styles.badge} ${styles.pending}`} />}
        </button>
        {!soundOn && panel === "none" && (
          <button className={styles.soundBtn} onClick={unlockAudio}>
            <MutedIcon />
            點一下開啟聲音
          </button>
        )}
      </div>

      {!busy && panel === "none" && (
        <p className={styles.hint}>
          {shared ? `所有裝置加起來至少 ${need} 根手指` : `放上至少 ${need} 根手指`}
          {shared && <span className={styles.sub}>每台放一根也可以</span>}
        </p>
      )}
      {snap.phase === "idle" && spentCount > 0 && localCount === 0 && <p className={styles.hint}>放開手指，再重新放上</p>}
      {snap.phase === "idle" && localCount > 0 && total < need && (
        <p className={styles.hint}>
          {total} / {need} 根手指
          {shared && <span className={styles.sub}>等其他裝置放上來</span>}
        </p>
      )}

      {panel === "winners" && (
        <div className={styles.card}>
          <div className={styles.cardTitle}>選出幾人</div>
          <div className={styles.stepper}>
            <button onClick={() => setWinners(snap.winners - 1)} disabled={snap.winners <= 1} aria-label="減少">
              −
            </button>
            <span>{snap.winners}</span>
            <button onClick={() => setWinners(snap.winners + 1)} disabled={snap.winners >= MAX_WINNERS} aria-label="增加">
              +
            </button>
          </div>
        </div>
      )}

      {panel === "devices" && room && (
        <div className={`${styles.card} ${styles.devicesCard}`}>
          <div className={styles.cardTitle}>用其他手機掃描加入</div>
          {qr?.room === room ? (
            // eslint-disable-next-line @next/next/no-img-element -- a generated data: URL, nothing to optimize
            <img className={styles.qr} src={qr.src} alt={`加入房間 ${room} 的 QR code`} />
          ) : (
            <div className={styles.qr} />
          )}
          <div className={styles.code}>{room}</div>
          <div className={styles.meta}>
            {status === "online" ? `已連線 ${snap.devices} 台裝置` : "連線中…這台可以先自己玩"}
          </div>
          {isLocalhost && <div className={styles.warn}>目前用 localhost 開啟，其他手機掃不到。請改用電腦的區網 IP 開啟這個頁面。</div>}
          {copied === "failed" && <div className={styles.link}>{`${location.origin}/?r=${room}`}</div>}
          <div className={styles.actions}>
            <button className={styles.linkBtn} onClick={copyLink} aria-label="複製連結">
              {copied === "yes" ? <CheckIcon /> : <LinkIcon />}
              <span className={styles.url}>{copied === "yes" ? "已複製" : `${location.host}/?r=${room}`}</span>
            </button>
            <div className={styles.row}>
              <button className={styles.ghost} onClick={leaveRoom}>
                離開房間
              </button>
              <button className={styles.ghost} onClick={() => setPanel("none")}>
                完成
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

/**
 * Gives local fingers the colors the room assigned and clears up after a round.
 * Returns true when fingers left the round and the room should hear about it.
 */
function syncFingers(fingers: Map<string, Finger>, prev: Snapshot, s: Snapshot, deviceId: string, now: number) {
  let changed = false;
  // Round over: drop fingers that were frozen by the reveal; ones still held sit out.
  if (prev.reveal && !s.reveal) {
    for (const [id, f] of fingers) {
      if (f.lifted) {
        fingers.delete(id);
      } else if (f.colorIndex !== null) {
        f.colorIndex = null;
        f.spent = true;
        changed = true;
      }
    }
  }
  for (const f of fingers.values()) {
    const index = s.colors[keyOf(deviceId, f.id)];
    if (index !== undefined && f.colorIndex !== index && f.goneAt === null && !f.spent) {
      if (f.colorIndex === null) f.bornAt = now;
      f.colorIndex = index;
    }
  }
  return changed;
}

/** Every device buzzes when the winners land; only a device holding a winning finger plays the reveal sound. */
function scheduleReveal(s: Snapshot, deviceId: string, roomNow: number) {
  const reveal = s.reveal!;
  setTimeout(() => haptic([30, 40, 80]), Math.max(0, reveal.landAt - roomNow));
  if (reveal.winners.some((key) => key.startsWith(`${deviceId}:`))) playWin(reveal.landAt, roomNow);
}

const ROOM_KEY = "fingerwho-room";

/** Notes that this device just used the room, so reopening the tab soon keeps it. */
function touchRoom(code: string | null) {
  if (!code) return;
  try {
    localStorage.setItem(ROOM_KEY, JSON.stringify({ code, at: Date.now() }));
  } catch {
    // Storage blocked: rooms just never expire on this device.
  }
}

/** True when this device last used `code` more than ROOM_IDLE_MS ago. A room it has never seen is fresh. */
function roomExpired(code: string): boolean {
  try {
    const saved = JSON.parse(localStorage.getItem(ROOM_KEY) ?? "null") as { code: string; at: number } | null;
    return saved?.code === code && Date.now() - saved.at > ROOM_IDLE_MS;
  } catch {
    return false;
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // No async clipboard on plain http: fall back to a selected textarea.
    const area = document.createElement("textarea");
    area.value = text;
    area.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, text.length); // iOS ignores select() alone
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

let wakeLock: { release: () => Promise<void> } | null = null;

async function requestWakeLock() {
  if (wakeLock || !("wakeLock" in navigator)) return;
  try {
    const lock = await navigator.wakeLock.request("screen");
    wakeLock = lock;
    lock.addEventListener("release", () => (wakeLock = null));
  } catch {
    // Not allowed here (e.g. plain http): the screen may dim, nothing else breaks.
  }
}

function LinkIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function MutedIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M11 5 6 9H3v6h3l5 4z" />
      <path d="m22 9-6 6M16 9l6 6" />
    </svg>
  );
}

function PhonesIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="4" width="9" height="16" rx="2" />
      <path d="M15 7h4a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-4" />
      <path d="M18 11v4M16 13h4" />
    </svg>
  );
}

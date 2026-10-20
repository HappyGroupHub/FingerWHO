"use client";

import { ClientMsg, ServerMsg, Snapshot } from "./game";
import { Room } from "./room";

/** "solo": no room. "connecting": in a room but the server isn't reachable yet. "online": playing through the server. */
export type ConnectionStatus = "solo" | "connecting" | "online";

/** How the UI talks to the room. */
export interface Transport {
  readonly deviceId: string;
  send(msg: ClientMsg): void;
  /** Current time on the active room's clock (ms). */
  roomNow(): number;
  /** Start (or switch to) a shared room. Play carries on locally until the server answers. */
  joinRoom(code: string): void;
  /** Drop the shared room and keep playing on this device alone. */
  leaveRoom(): void;
  close(): void;
}

export interface TransportEvents {
  onSnapshot: (s: Snapshot) => void;
  onStatus: (s: ConnectionStatus) => void;
}

/**
 * Always keeps a room running in this tab, so the device can be played on its
 * own at any moment. When it is in a shared room and the server is reachable,
 * the server's room takes over; if the connection drops, the local one takes
 * back over. Both rooms see every touch, so either can take over at any time.
 */
export function createTransport(events: TransportEvents): Transport {
  const deviceId = getDeviceId();
  const local = new Room({
    now: Date.now,
    revealLead: 0,
    broadcast: (s) => {
      localSnap = s;
      // Hand over to the server between rounds, never in the middle of one.
      if (serverReady && s.phase !== "reveal") activate("server");
      else if (active === "local") events.onSnapshot(s);
    },
  });
  let localSnap: Snapshot = local.snapshot();
  let serverSnap: Snapshot | null = null;
  let active: "local" | "server" = "local";
  let serverReady = false;

  let code: string | null = null;
  let ws: WebSocket | null = null;
  let retry = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setTimeout> | null = null;
  // Best (lowest round-trip) clock samples win: offset = server clock - local clock.
  let offset = 0;
  let bestRtt = Infinity;
  let lastTouches: ClientMsg | null = null;
  let winners: ClientMsg | null = null;

  const activate = (which: "local" | "server") => {
    if (active === which) return;
    active = which;
    const snap = which === "server" ? serverSnap : localSnap;
    if (snap) events.onSnapshot(snap);
    events.onStatus(which === "server" ? "online" : code ? "connecting" : "solo");
  };

  const sendServer = (msg: ClientMsg) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  const ping = (count: number) => {
    sendServer({ t: "ping", c: Date.now() });
    // A burst on connect to settle the clock fast, then a slow trickle.
    pingTimer = setTimeout(() => ping(count + 1), count < 6 ? 150 : 5000);
  };

  const stopSocket = () => {
    if (pingTimer) clearTimeout(pingTimer);
    if (retryTimer) clearTimeout(retryTimer);
    pingTimer = retryTimer = null;
    if (ws) {
      ws.onclose = ws.onmessage = ws.onopen = null;
      ws.close();
    }
    ws = null;
    serverReady = false;
    serverSnap = null;
  };

  const connect = () => {
    if (!code) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${proto}://${location.host}/ws?room=${code}&device=${deviceId}`);
    ws = socket;
    socket.onopen = () => {
      retry = 0;
      bestRtt = Infinity;
      // The room's own setting wins for anyone joining; whoever opened the room brings theirs.
      if (winners) sendServer(winners);
      winners = null;
      if (lastTouches) sendServer(lastTouches);
      ping(0);
    };
    socket.onmessage = (e) => {
      const msg: ServerMsg = JSON.parse(e.data);
      if (msg.t === "state") {
        serverSnap = msg.s;
        // Keep the fallback room on the same setting in case the connection drops.
        if (msg.s.winners !== localSnap.winners && localSnap.phase !== "reveal") local.setWinners(msg.s.winners);
        if (active === "server") events.onSnapshot(msg.s);
        else if (!serverReady) {
          serverReady = true;
          if (localSnap.phase !== "reveal") activate("server");
        }
      } else if (msg.t === "pong") {
        const now = Date.now();
        const rtt = now - msg.c;
        // Let old samples age out slowly so a drifting clock still gets corrected.
        bestRtt += 2;
        if (rtt <= bestRtt) {
          bestRtt = rtt;
          offset = msg.s - (msg.c + now) / 2;
        }
      }
    };
    socket.onclose = () => {
      stopSocket();
      activate("local");
      events.onStatus("connecting");
      retryTimer = setTimeout(connect, Math.min(4000, 300 * 2 ** retry++));
    };
  };

  events.onSnapshot(localSnap);
  events.onStatus("solo");

  return {
    deviceId,
    send(msg) {
      if (msg.t === "touches") lastTouches = msg;
      // A setting changed while offline is pushed to the room once connected.
      if (msg.t === "winners" && ws?.readyState !== WebSocket.OPEN) winners = msg;
      if (msg.t === "touches") local.setTouches(deviceId, msg.ids);
      else if (msg.t === "winners") local.setWinners(msg.n);
      sendServer(msg);
    },
    roomNow: () => (active === "server" ? Date.now() + offset : Date.now()),
    joinRoom(next) {
      if (next === code) return;
      stopSocket();
      activate("local");
      code = next;
      // Someone joining takes the room's setting rather than pushing their own.
      winners = null;
      events.onStatus("connecting");
      connect();
    },
    leaveRoom() {
      if (!code) return;
      code = null;
      stopSocket();
      activate("local");
      events.onStatus("solo");
    },
    close() {
      code = null;
      stopSocket();
      local.dispose();
    },
  };
}

function getDeviceId(): string {
  try {
    const saved = sessionStorage.getItem("fingerwho-device");
    if (saved) return saved;
    const id = crypto.randomUUID().slice(0, 12);
    sessionStorage.setItem("fingerwho-device", id);
    return id;
  } catch {
    return Math.random().toString(36).slice(2, 14);
  }
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function newRoomCode(): string {
  let code = "";
  for (let i = 0; i < 5; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return code;
}

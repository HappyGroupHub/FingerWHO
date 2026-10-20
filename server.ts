import { createServer } from "http";
import { networkInterfaces } from "os";
import next from "next";
import { WebSocket, WebSocketServer } from "ws";
import { ClientMsg, REVEAL_LEAD_MS, ServerMsg } from "./lib/game";
import { Room } from "./lib/room";

const port = parseInt(process.env.PORT || "3000", 10);
const dev = process.env.NODE_ENV !== "production";
const ROOM_CODE = /^[A-Z0-9]{4,8}$/;
const ROOM_IDLE_TTL_MS = 5 * 60 * 1000;
/** Clients ping every 5 s; a socket silent for longer than this is a phone that went away. */
const SILENT_TIMEOUT_MS = 15 * 1000;

interface LiveRoom {
  room: Room;
  sockets: Map<string, WebSocket>;
  cleanup: ReturnType<typeof setTimeout> | null;
}

const rooms = new Map<string, LiveRoom>();

function getRoom(code: string): LiveRoom {
  let live = rooms.get(code);
  if (live) return live;
  const sockets = new Map<string, WebSocket>();
  const room = new Room({
    now: Date.now,
    revealLead: REVEAL_LEAD_MS,
    broadcast: (s) => {
      const data = JSON.stringify({ t: "state", s } satisfies ServerMsg);
      for (const ws of sockets.values()) if (ws.readyState === WebSocket.OPEN) ws.send(data);
    },
  });
  live = { room, sockets, cleanup: null };
  rooms.set(code, live);
  return live;
}

function join(ws: WebSocket, code: string, deviceId: string) {
  const live = getRoom(code);
  if (live.cleanup) clearTimeout(live.cleanup);
  live.cleanup = null;

  // A device that reconnects replaces its old socket.
  const old = live.sockets.get(deviceId);
  if (old && old !== ws) old.close();
  live.sockets.set(deviceId, ws);
  live.room.addDevice(deviceId);

  let lastSeen = Date.now();
  const watchdog = setInterval(() => {
    if (Date.now() - lastSeen > SILENT_TIMEOUT_MS) ws.terminate();
  }, 5000);

  ws.on("message", (raw) => {
    lastSeen = Date.now();
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.t === "ping") {
      ws.send(JSON.stringify({ t: "pong", c: msg.c, s: Date.now() } satisfies ServerMsg));
    } else if (msg.t === "touches" && Array.isArray(msg.ids)) {
      live.room.setTouches(deviceId, msg.ids.slice(0, 20).map(String));
    } else if (msg.t === "winners" && typeof msg.n === "number") {
      live.room.setWinners(msg.n);
    }
  });

  ws.on("close", () => {
    clearInterval(watchdog);
    if (live.sockets.get(deviceId) !== ws) return;
    live.sockets.delete(deviceId);
    live.room.removeDevice(deviceId);
    if (live.sockets.size === 0) {
      live.cleanup = setTimeout(() => {
        live.room.dispose();
        rooms.delete(code);
      }, ROOM_IDLE_TTL_MS);
    }
  });
}

const app = next({ dev });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer((req, res) => handle(req, res));
  const wss = new WebSocketServer({ noServer: true });
  const nextUpgrade = app.getUpgradeHandler();

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws") {
      nextUpgrade(req, socket, head);
      return;
    }
    const code = (url.searchParams.get("room") ?? "").toUpperCase();
    const deviceId = url.searchParams.get("device") ?? "";
    if (!ROOM_CODE.test(code) || !/^[\w-]{4,40}$/.test(deviceId)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => join(ws, code, deviceId));
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`> Ready on http://localhost:${port} (${dev ? "development" : "production"})`);
    for (const list of Object.values(networkInterfaces())) {
      for (const addr of list ?? []) {
        if (addr.family === "IPv4" && !addr.internal) console.log(`  On your network: http://${addr.address}:${port}`);
      }
    }
  });
});

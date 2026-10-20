// Cloudflare entry point: serves the static site and hands `/ws` connections to
// one Durable Object per room code, which runs the same `Room` as `server.ts`.
import { DurableObject } from "cloudflare:workers";
import { ClientMsg, REVEAL_LEAD_MS, ServerMsg } from "../lib/game";
import { Room } from "../lib/room";

interface Env {
  ASSETS: Fetcher;
  ROOMS: DurableObjectNamespace<RoomObject>;
}

const ROOM_CODE = /^[A-Z0-9]{4,8}$/;
const DEVICE_ID = /^[\w-]{4,40}$/;
/** Clients ping every 5 s; a socket silent for longer than this is a phone that went away. */
const SILENT_TIMEOUT_MS = 15 * 1000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/ws") return env.ASSETS.fetch(request);

    const code = (url.searchParams.get("room") ?? "").toUpperCase();
    const deviceId = url.searchParams.get("device") ?? "";
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
    if (!ROOM_CODE.test(code) || !DEVICE_ID.test(deviceId)) return new Response("Bad room or device", { status: 400 });
    return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(request);
  },
} satisfies ExportedHandler<Env>;

export class RoomObject extends DurableObject<Env> {
  private sockets = new Map<string, WebSocket>();
  private room = new Room({
    now: Date.now,
    revealLead: REVEAL_LEAD_MS,
    broadcast: (s) => {
      const data = JSON.stringify({ t: "state", s } satisfies ServerMsg);
      for (const ws of this.sockets.values()) {
        try {
          ws.send(data);
        } catch {
          // Closing socket; its close handler cleans up.
        }
      }
    },
  });

  async fetch(request: Request): Promise<Response> {
    const deviceId = new URL(request.url).searchParams.get("device")!;
    const [client, ws] = Object.values(new WebSocketPair());
    ws.accept();
    this.join(ws, deviceId);
    return new Response(null, { status: 101, webSocket: client });
  }

  private join(ws: WebSocket, deviceId: string) {
    // A device that reconnects replaces its old socket.
    const old = this.sockets.get(deviceId);
    this.sockets.set(deviceId, ws);
    if (old) old.close(1000, "replaced");
    this.room.addDevice(deviceId);

    let lastSeen = Date.now();
    const watchdog = setInterval(() => {
      if (Date.now() - lastSeen > SILENT_TIMEOUT_MS) ws.close(1001, "silent");
    }, 5000);

    ws.addEventListener("message", (event) => {
      lastSeen = Date.now();
      let msg: ClientMsg;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (msg.t === "ping") {
        ws.send(JSON.stringify({ t: "pong", c: msg.c, s: Date.now() } satisfies ServerMsg));
      } else if (msg.t === "touches" && Array.isArray(msg.ids)) {
        this.room.setTouches(deviceId, msg.ids.slice(0, 20).map(String));
      } else if (msg.t === "winners" && typeof msg.n === "number") {
        this.room.setWinners(msg.n);
      }
    });

    const leave = () => {
      clearInterval(watchdog);
      if (this.sockets.get(deviceId) !== ws) return;
      this.sockets.delete(deviceId);
      this.room.removeDevice(deviceId);
    };
    ws.addEventListener("close", leave);
    ws.addEventListener("error", leave);
  }
}

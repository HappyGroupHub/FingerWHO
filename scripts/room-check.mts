// Quick sanity run of the room rules: `npx tsx scripts/room-check.mts`
import assert from "node:assert/strict";
import { COUNTDOWN_MS, Snapshot, revealEnd } from "../lib/game.ts";
import { Room } from "../lib/room.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let last!: Snapshot;
const room = new Room({ now: Date.now, revealLead: 0, broadcast: (s) => (last = s) });
room.addDevice("a");
room.addDevice("b");

room.setTouches("a", ["1", "2"]);
room.setTouches("b", ["1"]);
assert.equal(last.phase, "countdown");
assert.deepEqual(new Set(Object.values(last.colors)).size, 3, "every finger gets its own color");

const firstEnd = last.countdownEndsAt!;
await sleep(50);
room.setTouches("b", ["1", "2"]);
assert.ok(last.countdownEndsAt! > firstEnd, "a new finger on another device restarts the countdown");

await sleep(COUNTDOWN_MS + 50);
assert.equal(last.phase, "reveal");
const r = last.reveal!;
assert.equal(r.winners.length, 1);
assert.ok(r.winners[0] in last.colors, "the winner is one of the fingers in the round");

room.setTouches("b", ["1", "2", "9"]); // a new finger mid-reveal; device a keeps holding on
assert.equal(last.phase, "reveal", "the result stays until the animation is over");
await sleep(revealEnd(r) - Date.now() + 50);
assert.equal(last.phase, "idle", "the round ends on time even though fingers are still down");
assert.deepEqual(Object.keys(last.colors), ["b:9"], "only the finger placed during the reveal is in the next round");

room.setTouches("a", ["2"]); // lifts a:1
room.setTouches("a", ["2", "1"]); // and puts it back
assert.deepEqual(Object.keys(last.colors).sort(), ["a:1", "b:9"], "a finger that was lifted and placed again rejoins");
assert.equal(last.phase, "countdown");

room.removeDevice("b");
assert.equal(last.devices, 1);
room.dispose();
console.log("room rules OK");

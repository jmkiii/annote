// Annote relay: dumb, trustless store-and-forward for signed events. Zero dependencies.
// Usage: node server.js [--port 8787] [--peers ws://other:8788,ws://...]
import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { serve, connect } from "./wsmini.js";
import "../extension/shared.js";
const { verifyEvent } = globalThis.Annote;

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++)
  if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[i + 1];

const PORT = parseInt(args.port || "8787");
const PEERS = (args.peers || "").split(",").filter(Boolean);
const DB = fileURLToPath(new URL(`./events-${PORT}.json`, import.meta.url));
const MAX_EVENT_BYTES = 300 * 1024;

const events = new Map();
if (existsSync(DB)) for (const ev of JSON.parse(readFileSync(DB, "utf8"))) events.set(ev.id, ev);
let saveT = null;
const save = () => {
  clearTimeout(saveT);
  saveT = setTimeout(() => writeFileSync(DB, JSON.stringify([...events.values()])), 2000);
};

// filter: { pages?: [pageId], kinds?: [kind], since?: ts }
const matches = (ev, f) => {
  if (f.since && ev.created < f.since) return false;
  const pageHit = f.pages ? (ev.page && f.pages.includes(ev.page)) : false;
  const kindHit = f.kinds ? f.kinds.includes(ev.kind) : false;
  if (!f.pages && !f.kinds) return true;
  return pageHit || kindHit;
};

const clients = new Set();   // { conn, subs: Map<subId, filter> }
const peerConns = new Set(); // outbound gossip connections

async function ingest(ev, from) {
  if (!ev?.id || typeof ev.id !== "string") return { ok: false, msg: "malformed" };
  if (events.has(ev.id)) return { ok: true, msg: "duplicate" };
  if (JSON.stringify(ev).length > MAX_EVENT_BYTES) return { ok: false, msg: "too large" };
  if (!(await verifyEvent(ev))) return { ok: false, msg: "bad signature" };
  events.set(ev.id, ev);
  save();
  for (const c of clients) {
    if (c.conn === from) continue;
    for (const [subId, f] of c.subs)
      if (matches(ev, f)) { c.conn.send(JSON.stringify(["EVENT", subId, ev])); break; }
  }
  for (const p of peerConns) if (p !== from) p.send(JSON.stringify(["EVENT", ev]));
  return { ok: true, msg: "" };
}

serve(PORT, (conn) => {
  const client = { conn, subs: new Map() };
  clients.add(client);
  let budget = 600; // naive rate limit, refilled each minute
  const refill = setInterval(() => (budget = 600), 60000);

  conn.onmessage = async (data) => {
    if (--budget < 0) return;
    let msg; try { msg = JSON.parse(data); } catch { return; }
    const [type, a, b] = msg;
    if (type === "EVENT") {
      const { ok, msg: m } = await ingest(a, conn);
      conn.send(JSON.stringify(["OK", a?.id ?? null, ok, m]));
    } else if (type === "SUB" && typeof a === "string" && b && typeof b === "object") {
      client.subs.set(a, b);
      for (const ev of events.values())
        if (matches(ev, b)) conn.send(JSON.stringify(["EVENT", a, ev]));
      conn.send(JSON.stringify(["EOSE", a]));
    } else if (type === "UNSUB") {
      client.subs.delete(a);
    }
  };
  conn.onclose = () => { clients.delete(client); clearInterval(refill); };
});

// gossip: subscribe to everything on peer relays, cross-post what we ingest
for (const url of PEERS) {
  const dial = (attempt = 0) => connect(url, {
    onopen: (conn) => {
      attempt = 0;
      peerConns.add(conn);
      conn.send(JSON.stringify(["SUB", "gossip", { since: 0 }]));
      conn.onmessage = async (d) => {
        try {
          const m = JSON.parse(d);
          if (m[0] === "EVENT") await ingest(m.length > 2 ? m[2] : m[1], conn);
        } catch {}
      };
      conn.onclose = () => { peerConns.delete(conn); setTimeout(() => dial(attempt + 1), Math.min(30000, 1000 * 2 ** attempt)); };
    },
    onclose: () => setTimeout(() => dial(attempt + 1), Math.min(30000, 1000 * 2 ** attempt)),
  });
  dial();
}

console.log(`Annote relay on ws://0.0.0.0:${PORT}  events=${events.size}  peers=[${PEERS.join(", ")}]`);

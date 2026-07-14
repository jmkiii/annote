// Annote background: identity, relay pool, event store, ledger.
// Classic script so it runs as a Chrome MV3 service worker AND a Firefox event page.
// Network policy: WebSocket connections to user-configured relays ONLY. No fetch(), ever.
if (typeof importScripts === "function") importScripts("shared.js"); // Chrome SW; Firefox loads shared.js via background.scripts
// NOTE: no destructuring here — shared.js's function declarations are already
// global bindings in Firefox's event page, and re-declaring the same names
// (const createEvent = ...) is a fatal SyntaxError. Use the namespace instead.
const A = globalThis.Annote;
const api = globalThis.browser ?? globalThis.chrome;

const DEFAULT_RELAYS = ["ws://127.0.0.1:8787"];
const MAX_EVENTS = 20000;

let state = null; // { privKey, privJwk, pubkey, relays[] }
const events = new Map();          // id -> event
const ports = new Map();           // pageId -> Set<Port>
const sockets = new Map();         // url -> WebSocket
let persistTimer = null;

// ---------- init ----------
async function init() {
  if (state) return state;
  const st = await api.storage.local.get(["identity", "relays", "events"]);
  let identity = st.identity;
  if (!identity) {
    identity = await A.generateKeypair();
    await api.storage.local.set({ identity });
  }
  state = {
    privJwk: identity.privJwk,
    pubkey: identity.pubkey,
    privKey: await A.importPrivate(identity.privJwk),
    relays: st.relays || DEFAULT_RELAYS,
  };
  for (const ev of st.events || []) events.set(ev.id, ev);
  connectRelays();
  return state;
}
const ready = init();

function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    let list = [...events.values()];
    if (list.length > MAX_EVENTS) {
      list.sort((a, b) => b.created - a.created);
      list = list.slice(0, MAX_EVENTS);
    }
    api.storage.local.set({ events: list });
  }, 300);
}

// ---------- relays ----------
function connectRelays() {
  for (const url of state.relays) if (!sockets.has(url)) connectRelay(url);
  for (const [url, ws] of sockets) if (!state.relays.includes(url)) { ws.close(); sockets.delete(url); }
}

function connectRelay(url, attempt = 0) {
  let ws;
  try { ws = new WebSocket(url); } catch { return scheduleReconnect(url, attempt); }
  sockets.set(url, ws);
  ws.onopen = () => {
    attempt = 0;
    ws.send(JSON.stringify(["SUB", "global", { kinds: ["transfer", "profile"], since: 0 }]));
    for (const pageId of ports.keys()) subscribePage(ws, pageId);
    notifyStatus();
  };
  ws.onmessage = async (m) => {
    let msg; try { msg = JSON.parse(m.data); } catch { return; }
    if (msg[0] === "EVENT") await ingest(msg[2], { fromRelay: true });
  };
  ws.onclose = () => { sockets.delete(url); notifyStatus(); if (state.relays.includes(url)) scheduleReconnect(url, attempt + 1); };
  ws.onerror = () => ws.close();
}
function scheduleReconnect(url, attempt) {
  setTimeout(() => { if (state.relays.includes(url) && !sockets.has(url)) connectRelay(url, attempt); },
    Math.min(30000, 1000 * 2 ** attempt));
}
function subscribePage(ws, pageId) {
  if (ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify(["SUB", "p:" + pageId, { pages: [pageId], since: 0 }]));
}
const openRelays = () => [...sockets.values()].filter(w => w.readyState === WebSocket.OPEN).length;
function notifyStatus() {
  for (const set of ports.values()) for (const p of set) safePost(p, { type: "status", relayCount: openRelays() });
}
function broadcast(ev) {
  const line = JSON.stringify(["EVENT", ev]);
  for (const ws of sockets.values()) if (ws.readyState === WebSocket.OPEN) ws.send(line);
}

// ---------- event handling ----------
async function ingest(ev, { fromRelay = false } = {}) {
  if (!ev || events.has(ev.id)) return false;
  if (JSON.stringify(ev).length > 300 * 1024) return false;
  if (fromRelay && !(await A.verifyEvent(ev))) return false;
  events.set(ev.id, ev);
  persist();
  if (ev.page && ports.has(ev.page))
    for (const p of ports.get(ev.page)) safePost(p, { type: "event", event: ev });
  return true;
}
function safePost(port, msg) { try { port.postMessage(msg); } catch {} }

function pageEvents(pageId) {
  return [...events.values()].filter(e => e.page === pageId);
}
function profiles() {
  const out = {};
  for (const e of events.values())
    if (e.kind === "profile" && (!out[e.pubkey] || out[e.pubkey].created < e.created))
      out[e.pubkey] = { name: e.content?.name, created: e.created };
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.name]));
}

async function publish(fields) {
  const ev = await A.createEvent(fields, state.privKey, state.pubkey);
  await ingest(ev);
  broadcast(ev);
  return ev;
}

// ---------- content-script ports ----------
api.runtime.onConnect.addListener((port) => {
  if (port.name !== "annote") return;
  let joined = null;
  port.onMessage.addListener(async (msg) => {
   try {
    await ready;
    if (msg.type === "join") {
      const pageId = await A.pageIdFor(msg.url);
      joined = pageId;
      if (!ports.has(pageId)) ports.set(pageId, new Set());
      ports.get(pageId).add(port);
      for (const ws of sockets.values()) subscribePage(ws, pageId);
      safePost(port, {
        type: "init", pageId, pubkey: state.pubkey, relayCount: openRelays(),
        events: pageEvents(pageId), profiles: profiles(),
      });
    } else if (msg.type === "publish") {
      const { type, ...fields } = msg;
      const ev = await publish(fields);
      safePost(port, { type: "published", event: ev });
    }
   } catch (e) { safePost(port, { type: "error", message: String((e && e.message) || e) }); }
  });
  port.onDisconnect.addListener(() => {
    if (joined && ports.has(joined)) {
      ports.get(joined).delete(port);
      if (!ports.get(joined).size) ports.delete(joined);
    }
  });
});

// ---------- popup messages ----------
api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    await ready;
    switch (msg.type) {
      case "wallet:get": {
        const { balances, staked } = A.computeLedger(events.values());
        const stake = staked.get(state.pubkey) || 0;
        sendResponse({
          pubkey: state.pubkey,
          balance: balances.get(state.pubkey) || 0,
          staked: stake,
          weight: A.MINT.unstakedWeight + (1 - A.MINT.unstakedWeight) * Math.min(1, stake / A.MINT.stakeFull),
          name: profiles()[state.pubkey] || "",
          relays: state.relays,
          connected: [...sockets.values()].filter(w => w.readyState === WebSocket.OPEN).length,
          eventCount: events.size,
        });
        break;
      }
      case "wallet:stake": {
        const { balances, staked } = A.computeLedger(events.values());
        const avail = (balances.get(state.pubkey) || 0) - (staked.get(state.pubkey) || 0);
        if (!(msg.amount > 0) || msg.amount > avail) { sendResponse({ error: "insufficient available balance" }); break; }
        await publish({ kind: "stake", content: { amount: msg.amount } });
        sendResponse({ ok: true });
        break;
      }
      case "wallet:unstake": {
        const { staked } = A.computeLedger(events.values());
        if (!(msg.amount > 0) || msg.amount > (staked.get(state.pubkey) || 0)) { sendResponse({ error: "not that much staked" }); break; }
        await publish({ kind: "unstake", content: { amount: msg.amount } });
        sendResponse({ ok: true, note: "funds unlock after the 7-day delay" });
        break;
      }
      case "events:export":
        sendResponse({ events: [...events.values()] });
        break;
      case "events:clear":
        events.clear();
        await api.storage.local.set({ events: [] });
        sendResponse({ ok: true });
        break;
      case "wallet:send": {
        const { nonces, balances, staked } = A.computeLedger(events.values());
        const bal = (balances.get(state.pubkey) || 0) - (staked.get(state.pubkey) || 0);
        if (msg.amount <= 0 || msg.amount > bal) { sendResponse({ error: "insufficient available (unstaked) balance" }); break; }
        const ev = await publish({
          kind: "transfer", nonce: nonces.get(state.pubkey) || 0,
          content: { to: msg.to, amount: msg.amount, memo: msg.memo || "" },
        });
        sendResponse({ ok: true, event: ev });
        break;
      }
      case "profile:set":
        await publish({ kind: "profile", content: { name: String(msg.name).slice(0, 40) } });
        sendResponse({ ok: true });
        break;
      case "relays:set":
        state.relays = msg.relays.filter(u => /^wss?:\/\//.test(u));
        await api.storage.local.set({ relays: state.relays });
        connectRelays();
        sendResponse({ ok: true, relays: state.relays });
        break;
      case "key:export":
        sendResponse({ privJwk: state.privJwk, pubkey: state.pubkey });
        break;
      case "key:import":
        await api.storage.local.set({ identity: { privJwk: msg.privJwk, pubkey: msg.pubkey } });
        state = null; init().then(() => sendResponse({ ok: true }));
        return;
      default:
        sendResponse({ error: "unknown message" });
    }
  })();
  return true; // async
});

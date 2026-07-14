// Annote shared library: crypto, events, ledger.
// Runs in the extension service worker AND in Node (tests) — uses only globalThis.crypto.

const te = new TextEncoder();

function bytesToHex(b) {
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
}
function hexToBytes(h) {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

async function sha256hex(str) {
  return bytesToHex(await crypto.subtle.digest("SHA-256", te.encode(str)));
}

// ---------- keys ----------
const ALG = { name: "ECDSA", namedCurve: "P-256" };
const SIG = { name: "ECDSA", hash: "SHA-256" };

async function generateKeypair() {
  const kp = await crypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
  const privJwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const pubRaw = await crypto.subtle.exportKey("raw", kp.publicKey);
  return { privJwk, pubkey: bytesToHex(pubRaw) };
}

async function importPrivate(privJwk) {
  return crypto.subtle.importKey("jwk", privJwk, ALG, false, ["sign"]);
}
async function importPublic(pubkeyHex) {
  return crypto.subtle.importKey("raw", hexToBytes(pubkeyHex), ALG, false, ["verify"]);
}

// ---------- events ----------
// Canonical form: sorted-key JSON of all fields except id/sig.
function canonicalize(ev) {
  const keys = Object.keys(ev).filter(k => k !== "id" && k !== "sig").sort();
  const o = {};
  for (const k of keys) o[k] = ev[k];
  return JSON.stringify(o);
}

async function createEvent(fields, privKey, pubkeyHex) {
  const ev = { ...fields, pubkey: pubkeyHex, created: fields.created ?? Date.now() };
  ev.id = await sha256hex(canonicalize(ev));
  const sig = await crypto.subtle.sign(SIG, privKey, te.encode(ev.id));
  ev.sig = bytesToHex(sig);
  return ev;
}

async function verifyEvent(ev) {
  try {
    if (ev.id !== await sha256hex(canonicalize(ev))) return false;
    const pub = await importPublic(ev.pubkey);
    return crypto.subtle.verify(SIG, pub, hexToBytes(ev.sig), te.encode(ev.id));
  } catch { return false; }
}

// ---------- page identity ----------
const STRIP_PARAMS = /^(utm_|fbclid|gclid|mc_eid|igshid|ref_src)/;
function normalizeUrl(raw) {
  const u = new URL(raw);
  u.hash = "";
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !STRIP_PARAMS.test(k))
    .sort(([a], [b]) => a.localeCompare(b));
  u.search = "";
  const q = params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  return `${u.protocol}//${u.host.toLowerCase()}${u.pathname}${q ? "?" + q : ""}`;
}
async function pageIdFor(url) {
  return sha256hex(normalizeUrl(url));
}

// ---------- ledger ----------
// Balances are a pure function of the event set. Deterministic across replayers.
const GENESIS = Date.UTC(2026, 0, 1);
const YEAR = 365 * 24 * 3600 * 1000;
const DAY = 24 * 3600 * 1000;

const MINT = {
  react:  { author: 1.0, actor: 0.10 },
  reply:  { author: 2.0, actor: 0.20 },
  rate:   { author: 1.5, actor: 0.15 },
  pioneer: 5.0,
  pairDailyLimit: 5,
  dailyEarnCap: 100,
  dailyGiveCap: 20,
  maxFutureMs: 10 * 60 * 1000,
  // Proof-of-stake weighting: locked NOTE scales minting power.
  stakeFull: 10,           // stake at which an account mints at full weight
  unstakedWeight: 0.2,     // mint-weight floor for unstaked accounts
  unstakeDelayMs: 7 * DAY, // unstaked funds release after this lockup
};

function epochFactor(ts) {
  const years = Math.max(0, Math.floor((ts - GENESIS) / YEAR));
  return 1 / Math.pow(2, years);
}

// events: iterable of verified events. now: clock for future-dating + unstake maturity.
// Deterministic: same event set => same balances/stakes on every client.
function computeLedger(events, now = Date.now()) {
  const evs = [...events].sort((a, b) => a.created - b.created || (a.id < b.id ? -1 : 1));
  const byId = new Map(evs.map(e => [e.id, e]));
  const bal = new Map();      // pubkey -> total balance (incl. staked)
  const staked = new Map();   // pubkey -> locked NOTE (incl. pending unstakes)
  const pending = [];         // { key, amount, releaseAt }
  const nonces = new Map();
  const pairDay = new Map();
  const earnedDay = new Map();
  const givenDay = new Map();
  const annotatedPages = new Set();
  const add = (k, amt) => bal.set(k, (bal.get(k) || 0) + amt);
  const lock = (k, amt) => staked.set(k, (staked.get(k) || 0) + amt);
  const stakeOf = (k) => staked.get(k) || 0;
  const available = (k) => (bal.get(k) || 0) - stakeOf(k);
  // Sybil defense: an account's minting power scales with its locked stake.
  const weight = (k) => MINT.unstakedWeight + (1 - MINT.unstakedWeight) * Math.min(1, stakeOf(k) / MINT.stakeFull);
  const capped = (map, key, want, cap) => {
    const used = map.get(key) || 0;
    const grant = Math.max(0, Math.min(want, cap - used));
    map.set(key, used + grant);
    return grant;
  };
  const mature = (t) => {
    for (let i = pending.length - 1; i >= 0; i--)
      if (pending[i].releaseAt <= t) { lock(pending[i].key, -pending[i].amount); pending.splice(i, 1); }
  };

  for (const ev of evs) {
    if (ev.created > now + MINT.maxFutureMs) continue;
    mature(ev.created);
    const eps = epochFactor(ev.created);
    const day = Math.floor(ev.created / DAY);

    if (ev.kind === "transfer") {
      const expected = nonces.get(ev.pubkey) || 0;
      const { to, amount } = ev.content || {};
      if (ev.nonce === expected && typeof amount === "number" && amount > 0 &&
          available(ev.pubkey) >= amount && typeof to === "string") {
        add(ev.pubkey, -amount);
        add(to, amount);
        nonces.set(ev.pubkey, expected + 1);
      }
      continue;
    }

    if (ev.kind === "stake") {
      const amt = ev.content?.amount;
      if (typeof amt === "number" && amt > 0 && available(ev.pubkey) >= amt) lock(ev.pubkey, amt);
      continue;
    }

    if (ev.kind === "unstake") {
      const amt = ev.content?.amount;
      const alreadyPending = pending.filter(p => p.key === ev.pubkey).reduce((s, p) => s + p.amount, 0);
      if (typeof amt === "number" && amt > 0 && stakeOf(ev.pubkey) - alreadyPending >= amt)
        pending.push({ key: ev.pubkey, amount: amt, releaseAt: ev.created + MINT.unstakeDelayMs });
      continue;
    }

    if ((ev.kind === "note" || ev.kind === "draw") && ev.page) {
      if (!annotatedPages.has(ev.page)) {
        annotatedPages.add(ev.page);
        const grant = capped(earnedDay, `${day}|${ev.pubkey}`, MINT.pioneer * eps * weight(ev.pubkey), MINT.dailyEarnCap * eps);
        add(ev.pubkey, grant);
      }
      continue;
    }

    const rule = MINT[ev.kind]; // react | reply | rate
    if (!rule) continue;
    if (ev.kind === "react" && ev.content?.up === -1) continue; // disagree: social signal only, never mints
    const target = ev.refs && ev.refs[0] ? byId.get(ev.refs[0]) : null;
    const author = target ? target.pubkey : null;
    if (!author || author === ev.pubkey) continue; // self-engagement mints nothing
    const pk = `${day}|${ev.pubkey}|${author}`;
    const n = pairDay.get(pk) || 0;
    if (n >= MINT.pairDailyLimit) continue;
    pairDay.set(pk, n + 1);
    const w = weight(ev.pubkey); // the ENGAGER's stake gates minting
    add(author, capped(earnedDay, `${day}|${author}`, rule.author * eps * w, MINT.dailyEarnCap * eps));
    add(ev.pubkey, capped(givenDay, `${day}|${ev.pubkey}`, rule.actor * eps * w, MINT.dailyGiveCap * eps));
  }
  mature(now);
  return { balances: bal, nonces, staked };
}

// Expose for consumers (classic scripts, event pages, service workers, ESM wrapper).
globalThis.Annote = {
  bytesToHex, hexToBytes, sha256hex,
  generateKeypair, importPrivate, importPublic,
  canonicalize, createEvent, verifyEvent,
  normalizeUrl, pageIdFor,
  GENESIS, MINT, epochFactor, computeLedger,
};

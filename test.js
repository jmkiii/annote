// Node test for Annote crypto + PoS ledger. Run: node test.js
import "./extension/shared.js";
const {
  generateKeypair, importPrivate, createEvent, verifyEvent,
  computeLedger, epochFactor, GENESIS, MINT, normalizeUrl, pageIdFor,
} = globalThis.Annote;

let pass = 0, fail = 0;
const ok = (cond, name) => { cond ? pass++ : (fail++, console.error("FAIL:", name)); };
const approx = (a, b) => Math.abs(a - b) < 1e-9;
const DAY = 24 * 3600 * 1000;
const W0 = MINT.unstakedWeight; // 0.2

const T0 = GENESIS + 1000;
let clock = T0;
async function actor() {
  const { privJwk, pubkey } = await generateKeypair();
  const priv = await importPrivate(privJwk);
  return { pubkey, ev: (fields) => createEvent({ created: fields.created ?? (clock += 1000), ...fields }, priv, pubkey) };
}

const A = await actor(), U = await actor(), V = await actor(), S = await actor();

// --- signatures ---
const note = await A.ev({ kind: "note", page: "p1", anchor: { type: "point", x: 1, y: 2 }, content: { text: "hi" } });
ok(await verifyEvent(note), "valid event verifies");
ok(!(await verifyEvent({ ...note, content: { text: "tampered" } })), "tampered content rejected");
ok(!(await verifyEvent({ ...note, pubkey: U.pubkey })), "wrong pubkey rejected");

// --- URL normalization ---
ok(normalizeUrl("https://Ex.com/a?utm_source=x&b=2&a=1#frag") === "https://ex.com/a?a=1&b=2", "url normalization");
ok((await pageIdFor("https://ex.com/a")).length === 64, "pageId is sha256 hex");
ok(approx(epochFactor(GENESIS + 366 * DAY), 0.5), "annual halving");

// --- unstaked minting (weight floor) ---
const evs = [note]; // A pioneers p1 -> 5 * W0 = 1
evs.push(await U.ev({ kind: "react", refs: [note.id], content: { up: 1 } }));   // A +1*W0, U +0.1*W0
evs.push(await U.ev({ kind: "reply", refs: [note.id], content: { text: "!" } })); // A +2*W0, U +0.2*W0
evs.push(await A.ev({ kind: "react", refs: [note.id], content: { up: 1 } }));   // self: nothing
evs.push(await U.ev({ kind: "react", refs: [note.id], content: { up: -1 } }));  // disagree: never mints

let { balances } = computeLedger(evs, clock + 1e6);
ok(approx(balances.get(A.pubkey), (5 + 1 + 2) * W0), "unstaked author minting at weight floor");
ok(approx(balances.get(U.pubkey), (0.1 + 0.2) * W0), "unstaked actor minting at weight floor");

// --- pair daily cap (disagree consumed one pair slot? no: disagree skips before pair count) ---
const spam = [];
for (let i = 0; i < 10; i++) spam.push(await U.ev({ kind: "react", refs: [note.id], content: { up: 1 } }));
({ balances } = computeLedger([...evs, ...spam], clock + 1e6));
ok(approx(balances.get(A.pubkey), (5 + 1 + 2) * W0 + 3 * 1 * W0), "pair daily mint cap enforced");
const aAfterSpam = (5 + 1 + 2) * W0 + 3 * W0; // 2.2

// --- staking: earn, lock, weight, delayed release ---
const sEvents = [];
for (let i = 0; i < 10; i++)
  sEvents.push(await S.ev({ kind: "note", page: `s${i}`, anchor: { type: "point", x: 0, y: 0 }, content: { text: "pioneer" } }));
// S balance = 10 * (5 * W0) = 10
const tStake = clock + 1000;
sEvents.push(await S.ev({ created: tStake, kind: "stake", content: { amount: 10 } }));
// locked: transfer must fail
sEvents.push(await S.ev({ created: tStake + 1000, kind: "transfer", nonce: 0, content: { to: V.pubkey, amount: 1 } }));
let led = computeLedger([...evs, ...spam, ...sEvents], tStake + 2000);
ok(approx(led.balances.get(S.pubkey), 10), "staker earned pioneer rewards");
ok(approx(led.staked.get(S.pubkey), 10), "stake locked");
ok(!led.balances.get(V.pubkey), "transfer of staked funds rejected");

// staked engager mints at full weight
const sReact = await S.ev({ created: tStake + 3000, kind: "react", refs: [note.id], content: { up: 1 } });
led = computeLedger([...evs, ...spam, ...sEvents, sReact], tStake + 4000);
ok(approx(led.balances.get(A.pubkey), aAfterSpam + 1.0), "fully-staked engager mints at weight 1.0");

// unstake: funds stay locked during delay, release after
const tUn = tStake + 5000;
const unstake = await S.ev({ created: tUn, kind: "unstake", content: { amount: 4 } });
const earlySpend = await S.ev({ created: tUn + 1000, kind: "transfer", nonce: 0, content: { to: V.pubkey, amount: 2 } });
led = computeLedger([...evs, ...spam, ...sEvents, sReact, unstake, earlySpend], tUn + 2000);
ok(!led.balances.get(V.pubkey), "spend during unstake lockup rejected");
const lateSpend = await S.ev({ created: tUn + MINT.unstakeDelayMs + 1000, kind: "transfer", nonce: 0, content: { to: V.pubkey, amount: 2 } });
led = computeLedger([...evs, ...spam, ...sEvents, sReact, unstake, lateSpend], tUn + MINT.unstakeDelayMs + 2000);
ok(approx(led.balances.get(V.pubkey), 2), "spend after unstake delay succeeds");
ok(approx(led.staked.get(S.pubkey), 6), "remaining stake still locked");

// over-unstake rejected
const overUn = await S.ev({ created: tUn + 100, kind: "unstake", content: { amount: 999 } });
led = computeLedger([...evs, ...spam, ...sEvents, sReact, unstake, overUn], tUn + MINT.unstakeDelayMs + 2000);
ok(approx(led.staked.get(S.pubkey), 6), "over-unstake ignored");

// --- transfers / double-spend (A has 3.2 after S's react) ---
const t1 = await A.ev({ kind: "transfer", nonce: 0, content: { to: V.pubkey, amount: 2 } });
const t2 = await A.ev({ kind: "transfer", nonce: 0, content: { to: V.pubkey, amount: 2 } }); // replayed nonce
const t3 = await A.ev({ kind: "transfer", nonce: 1, content: { to: V.pubkey, amount: 9999 } }); // overdraft
const all = [...evs, ...spam, ...sEvents, sReact, t1, t2, t3];
led = computeLedger(all, clock + 1e6);
ok(approx(led.balances.get(V.pubkey), 2), "transfer applied once; double-spend + overdraft rejected");
ok(approx(led.balances.get(A.pubkey), aAfterSpam + 1 - 2), "sender debited");

// --- determinism ---
const b1 = computeLedger(all, clock + 1e6).balances;
const b2 = computeLedger([...all].reverse(), clock + 1e6).balances;
ok([...b1].every(([k, v]) => approx(b2.get(k) || 0, v)), "ledger is order-independent (deterministic replay)");

// --- future-dated events ignored ---
const future = await U.ev({ created: Date.now() + 1e9, kind: "react", refs: [note.id], content: { up: 1 } });
const b3 = computeLedger([...evs, future], clock + 1e6).balances;
ok(approx(b3.get(A.pubkey), (5 + 1 + 2) * W0), "future-dated event ignored by ledger");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

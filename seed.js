// Seed demo engagement onto any page — eight personas, threads, reactions,
// ratings, vegetation-worthy consensus and contention, and one ink drawing.
// Usage:  node seed.js "<exact page URL from the address bar>"  [ws://127.0.0.1:8787]
import "./extension/shared.js";
import { connect } from "./relay/wsmini.js";
const A = globalThis.Annote;

const url = process.argv[2];
if (!url) { console.error('usage: node seed.js "<page URL>" [relay]'); process.exit(1); }
const relay = process.argv[3] || "ws://127.0.0.1:8787";
const page = await A.pageIdFor(url);

const NAMES = ["Cyan Lichen", "Amber Fox", "Lush Fern", "Quiet Moss", "Old Root", "River Clay", "Night Owl", "Paper Wasp"];
const personas = [];
for (const name of NAMES) {
  const { privJwk, pubkey } = await A.generateKeypair();
  personas.push({ name, pubkey, priv: await A.importPrivate(privJwk) });
}
let t = Date.now() - 5 * 24 * 3600 * 1000; // conversation began five days ago
const tick = () => (t += Math.floor(3600 * 1000 * (0.4 + Math.random() * 3)));
const events = [];
const ev = async (p, fields) => {
  const e = await A.createEvent({ created: tick(), ...fields }, p.priv, p.pubkey);
  events.push(e);
  return e;
};

for (const p of personas) await ev(p, { kind: "profile", content: { name: p.name } });
const [cy, am, lu, qm, orr, rc, no, pw] = personas;

// --- consensus thread on the title (deep-climb demo, grows lush) ---
const t1 = await ev(cy, {
  kind: "note", page,
  anchor: { type: "quote", exact: "House door (Georgetown)", prefix: "", suffix: "",
    fp: { heading: "", surrounding: "House door (Georgetown)", tag: "span", yr: 0.04 } },
  content: { text: "A free door is never just a door. Somewhere a house is letting go of a threshold." },
});
let parent = t1;
for (const [p, text] of [
  [am, "Third free door in Georgetown this month. Something is happening to these houses."],
  [lu, "Renovation wave. The doors outlive the walls that held them."],
  [qm, "Picked one of these up last spring — solid core, 1940s. They don't make them anymore."],
  [rc, "Is this one solid? The grain in the photo looks real."],
  [cy, "Zoom the second photo — oak under one coat of paint. Worth the trip."],
]) parent = await ev(p, { kind: "reply", page, refs: [parent.id], content: { text } });
for (const p of [am, lu, qm, orr, rc, no, pw]) await ev(p, { kind: "react", page, refs: [t1.id], content: { up: 1 } });

// --- contentious point note (grows thorny) ---
const t2 = await ev(pw, {
  kind: "note", page, anchor: { type: "point", x: 720, y: 520 },
  content: { text: "Free stuff on craigslist is landfill-diversion theater. Nobody ever picks these up." },
});
for (const p of [cy, am, lu, qm, rc]) await ev(p, { kind: "react", page, refs: [t2.id], content: { up: -1 } });
for (const p of [no, orr]) await ev(p, { kind: "react", page, refs: [t2.id], content: { up: 1 } });
await ev(cy, { kind: "reply", page, refs: [t2.id], content: { text: "I furnished half my apartment from this section. Speak for yourself." } });
await ev(pw, { kind: "reply", page, refs: [t2.id], content: { text: "The other half came from the curb, I assume." } });

// --- scattered smaller notes ---
const t3 = await ev(orr, { kind: "note", page, anchor: { type: "point", x: 420, y: 950 },
  content: { text: "That grass needs cutting more than the door needs hauling." } });
for (const p of [no, rc, am]) await ev(p, { kind: "react", page, refs: [t3.id], content: { up: 1 } });
const t4 = await ev(lu, {
  kind: "note", page,
  anchor: { type: "quote", exact: "QR Code Link to This Post", prefix: "", suffix: "",
    fp: { heading: "", surrounding: "QR Code Link to This Post", tag: "p", yr: 0.3 } },
  content: { text: "Has anyone in history ever scanned one of these?" },
});
await ev(am, { kind: "reply", page, refs: [t4.id], content: { text: "Museum docents and nobody else." } });
for (const p of [qm, no]) await ev(p, { kind: "react", page, refs: [t4.id], content: { up: 1 } });

// --- page ratings ---
for (const [p, stars] of [[cy, 4], [am, 5], [lu, 4], [no, 3]])
  await ev(p, { kind: "rate", page, content: { stars } });

// --- one ink drawing: a wobbly clay circle, drawn slow-then-fast (alpha varies) ---
const pts = [];
for (let i = 0; i <= 44; i++) {
  const a = (i / 44) * Math.PI * 2;
  const r = 170 + Math.sin(i * 1.7) * 14;
  pts.push([540 + Math.cos(a) * r, 440 + Math.sin(a) * r,
    Math.round((0.35 + 0.6 * Math.abs(Math.sin(i / 6))) * 100) / 100]);
}
await ev(rc, { kind: "draw", page, anchor: { type: "doc" },
  content: { strokes: [{ color: "#bc6c25", width: 6, points: pts }] } });

// --- publish everything to the relay ---
connect(relay, {
  onopen: (c) => {
    let acked = 0;
    c.onmessage = (d) => {
      const m = JSON.parse(d);
      if (m[0] !== "OK") return;
      if (!m[2]) console.error("rejected:", m[3]);
      if (++acked === events.length) {
        console.log(`seeded ${events.length} events from ${personas.length} personas onto\n  ${url}\nReload the page to see the garden.`);
        process.exit(0);
      }
    };
    for (const e of events) c.send(JSON.stringify(["EVENT", e]));
  },
  onclose: () => { console.error("relay unreachable at " + relay + " — is it running?"); process.exit(1); },
});
setTimeout(() => { console.error("timeout waiting for relay acks"); process.exit(1); }, 15000);

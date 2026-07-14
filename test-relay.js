// End-to-end relay test: publish from client A, receive on subscribed client B,
// verify forged events are rejected. Run: node test-relay.js
import { spawn } from "child_process";
import { connect } from "./relay/wsmini.js";
import "./extension/shared.js";
const { generateKeypair, importPrivate, createEvent } = globalThis.Annote;

const relay = spawn(process.execPath, ["relay/server.js", "--port", "8791"], { stdio: "inherit" });
await new Promise(r => setTimeout(r, 800));

const { privJwk, pubkey } = await generateKeypair();
const priv = await importPrivate(privJwk);
const ev = await createEvent(
  { kind: "note", page: "deadbeef", anchor: { type: "point", x: 1, y: 1 }, content: { text: "e2e" } },
  priv, pubkey);
const forged = { ...ev, id: "f".repeat(64), content: { text: "forged" } };

let pass = 0, fail = 0;
const done = (code) => { relay.kill(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(code); };
setTimeout(() => { console.error("TIMEOUT"); fail++; done(1); }, 8000);

connect("ws://127.0.0.1:8791", {
  onopen: (b) => {
    b.send(JSON.stringify(["SUB", "s1", { pages: ["deadbeef"], since: 0 }]));
    b.onmessage = (d) => {
      const m = JSON.parse(d);
      if (m[0] === "EVENT" && m[2].id === ev.id) {
        console.log("✓ subscriber received published event");
        pass++;
        if (pass >= 3) done(0);
      }
    };
    connect("ws://127.0.0.1:8791", {
      onopen: (a) => {
        a.onmessage = (d) => {
          const m = JSON.parse(d);
          if (m[0] !== "OK") return;
          if (m[1] === ev.id && m[2] === true) { console.log("✓ relay accepted signed event"); pass++; }
          if (m[1] === forged.id && m[2] === false) { console.log("✓ relay rejected forged event:", m[3]); pass++; }
          if (pass >= 3) done(0);
        };
        a.send(JSON.stringify(["EVENT", ev]));
        a.send(JSON.stringify(["EVENT", forged]));
      },
    });
  },
});

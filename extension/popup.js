const $ = (id) => document.getElementById(id);
const api = globalThis.browser ?? globalThis.chrome;
const send = (msg) => api.runtime.sendMessage(msg);
const status = (t, err) => { $("status").textContent = t; $("status").style.color = err ? "#e77" : "#7c7"; };

async function refresh() {
  const w = await send({ type: "wallet:get" });
  $("bal").textContent = (w.balance - w.staked).toFixed(2);
  $("stakeinfo").textContent = `${w.staked.toFixed(2)} staked · mint weight ${(w.weight * 100).toFixed(0)}%`;
  $("pk").textContent = `${w.pubkey}\n${w.connected} relay(s) connected · ${w.eventCount} events`;
  $("name").value = w.name || "";
  $("relays").value = w.relays.join("\n");
}
refresh();

$("saveName").onclick = async () => {
  await send({ type: "profile:set", name: $("name").value.trim() });
  status("Name published.");
};

$("send").onclick = async () => {
  const r = await send({ type: "wallet:send", to: $("to").value.trim(), amount: parseFloat($("amount").value) });
  if (r.error) return status(r.error, true);
  status("Transfer published.");
  refresh();
};

$("saveRelays").onclick = async () => {
  const relays = $("relays").value.split("\n").map(s => s.trim()).filter(Boolean);
  const r = await send({ type: "relays:set", relays });
  status(`Saved ${r.relays.length} relay(s).`);
  setTimeout(refresh, 800);
};

$("backup").onclick = async () => {
  const k = await send({ type: "key:export" });
  const blob = new Blob([JSON.stringify(k, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "annote-identity.json";
  a.click();
  status("Key exported — keep it safe.");
};

$("stakeBtn").onclick = async () => {
  const r = await send({ type: "wallet:stake", amount: parseFloat($("stakeAmt").value) });
  status(r.error || "Staked — mint weight increased."); refresh();
};
$("unstakeBtn").onclick = async () => {
  const r = await send({ type: "wallet:unstake", amount: parseFloat($("stakeAmt").value) });
  status(r.error || "Unstaking — funds unlock in 7 days."); refresh();
};
$("exportBtn").onclick = async () => {
  const r = await send({ type: "events:export" });
  const blob = new Blob([JSON.stringify(r.events, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "annote-events.json";
  a.click();
  status(`Exported ${r.events.length} events.`);
};

$("clearBtn").onclick = async () => {
  await send({ type: "events:clear" });
  status("Local cache cleared — reload pages to refetch from relays.");
  refresh();
};

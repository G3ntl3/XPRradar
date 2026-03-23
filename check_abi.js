// node check_abi.js
import fetch from "node-fetch";

const res  = await fetch("https://api.protonnz.com/v1/chain/get_abi", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ account_name: "simplelaunch" }),
});
const data = await res.json();
const abi  = data.abi;

// Find buy, sell, createtoken structs
const targets = ["buy", "sell", "createtoken", "init", "setdefaults"];

for (const actionName of targets) {
  const action = abi.actions.find(a => a.name === actionName);
  if (!action) continue;
  const struct = abi.structs.find(s => s.name === action.type);
  console.log(`\n=== ${actionName} ===`);
  if (struct) {
    struct.fields.forEach(f => console.log(`  ${f.name}: ${f.type}`));
  }
}

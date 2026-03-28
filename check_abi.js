import fetch from "node-fetch";
const RPC = "https://api.protonnz.com";

async function check() {
  const res = await fetch(`${RPC}/v1/chain/get_abi`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ account_name: "simplelaunch" }),
  });
  const data = await res.json();
  console.log("Tables:", JSON.stringify(data.abi.tables.map(t => t.name), null, 2));
}
check();

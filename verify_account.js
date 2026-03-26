
async function verify() {
  const accountName = 'gentle2';
  try {
    const res = await fetch('https://api.protonnz.com/v1/chain/get_account', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account_name: accountName }),
    });
    console.log("Status:", res.status);
    const data = await res.json();
    console.log("Account:", data.account_name ?? "Not Found");
  } catch (e) {
    console.error("Error:", e.message);
  }
}

verify();

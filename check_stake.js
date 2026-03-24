// Check what staking looks like on an existing account
// node check_stake.js
import https from "https"
// const https = require('https');
const body = JSON.stringify({account_name: 'gentle2'});
const req = https.request({
  hostname: 'api.protonnz.com',
  path: '/v1/chain/get_account',
  method: 'POST',
  headers: {'Content-Type':'application/json','Content-Length':body.length}
}, res => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => {
    const a = JSON.parse(d);
    console.log('net_limit:', JSON.stringify(a.net_limit));
    console.log('cpu_limit:', JSON.stringify(a.cpu_limit));
    console.log('self_delegated_bandwidth:', JSON.stringify(a.self_delegated_bandwidth));
    console.log('total_resources:', JSON.stringify(a.total_resources));
    console.log('core_liquid_balance:', a.core_liquid_balance);
  });
});
req.write(body);
req.end();

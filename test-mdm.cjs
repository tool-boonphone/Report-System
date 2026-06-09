const fetch = require('node-fetch');
async function run() {
  const res = await fetch("https://mdm-th.com/api/mdm/devices?pageNum=1&pageSize=5", {
    headers: {
      "X-API-Key": "isvEwiE1cRWyEy5bFWEVX6QSmQHv5a4PMvQ6NlV2mmFYSn46df6jn7chbSVJCBPq",
      "Accept": "application/json",
      "User-Agent": "Mozilla/5.0"
    }
  });
  const json = await res.json();
  console.log(JSON.stringify(json.rows.map(r => ({ id: r.id, lossStatus: r.lossStatus, type: typeof r.lossStatus })), null, 2));
}
run();

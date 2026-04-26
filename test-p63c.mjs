/**
 * test-p63c.mjs — ทดสอบ collected stream API จริง
 * ตรวจสอบว่า carry rows ถูกสร้างสำหรับงวด 3 และ 4
 */
import http from "http";

const options = {
  hostname: "localhost",
  port: 3000,
  path: "/api/trpc/debt.listDebtCollectedStream?input=" + encodeURIComponent(JSON.stringify({
    "0": {
      json: {
        search: "CT0925-PKN001-15462-01",
        section: "Fastfone365",
        page: 1,
        pageSize: 5
      }
    }
  })),
  method: "GET",
  headers: { "Content-Type": "application/json" }
};

let rawData = "";
const req = http.request(options, (res) => {
  res.on("data", (chunk) => { rawData += chunk; });
  res.on("end", () => {
    try {
      // Parse NDJSON (newline-delimited JSON)
      const lines = rawData.split("\n").filter(l => l.trim());
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          const result = parsed?.[0]?.result?.data?.json;
          if (result?.rows) {
            for (const row of result.rows) {
              console.log(`\n=== Contract: ${row.contractNo} ===`);
              for (const pay of (row.payments ?? [])) {
                const isCarry = pay.receiptNo === "(carry)";
                console.log(`  period=${pay.period} | receipt=${pay.receiptNo ?? "(null)"} | paidAt=${pay.paidAt} | total=${pay.total} | overpaid=${pay.overpaid} | isClose=${pay.isCloseRow} | remark=${pay.remark ?? ""}`);
              }
            }
          }
        } catch {}
      }
    } catch (e) {
      console.error("Parse error:", e.message);
      console.log("Raw:", rawData.slice(0, 500));
    }
  });
});

req.on("error", (e) => console.error("Request error:", e.message));
req.setTimeout(15000, () => { console.error("Timeout"); req.destroy(); });
req.end();

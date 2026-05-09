/**
 * probe-payment-time.mjs
 * ทดสอบดึง payment transaction โดยตรงจาก FF365 API
 * สำหรับ external_id ที่ payment_time เป็น NULL ใน DB
 * เพื่อตรวจสอบว่า API ยังส่ง null มาจริงหรือเปล่า
 *
 * Usage: node probe-payment-time.mjs
 */

import "dotenv/config";

const BASE_URL = process.env.FASTFONE_API_URL?.replace(/\/$/, "");
const USERNAME = process.env.FASTFONE_API_USERNAME;
const PASSWORD = process.env.FASTFONE_API_PASSWORD;

if (!BASE_URL || !USERNAME || !PASSWORD) {
  console.error("Missing FASTFONE_API_URL / USERNAME / PASSWORD env vars");
  process.exit(1);
}

// external_id ที่ดึงจาก DB (payment_time IS NULL, ทั้งข้อมูลเก่าและใหม่)
const NULL_SAMPLES = [
  // ข้อมูลเก่า (2024)
  "15590", "15591", "15592",
  // ข้อมูลปี 2025
  "94808", "94809", "94810", "94811", "94812",
  // ข้อมูลล่าสุด (2026)
];

// external_id ที่ payment_time มีค่า (สำหรับเปรียบเทียบ)
const HAS_PT_SAMPLES = [];

async function login() {
  const res = await fetch(`${BASE_URL}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  const body = await res.json();
  if (!body?.data?.access_token) {
    throw new Error(`Login failed: ${JSON.stringify(body)}`);
  }
  console.log("✅ Login OK");
  return body.data.access_token;
}

async function getPaymentPage(token, page = 1, limit = 100) {
  const url = `${BASE_URL}/api/v1/payment?action=transactions&page=${page}&limit=${limit}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json();
  return body;
}

async function main() {
  console.log(`\n🔍 Probing FF365 API: ${BASE_URL}`);
  console.log("=".repeat(60));

  const token = await login();

  // ดึงหน้าแรกของ payment transactions เพื่อดู structure
  console.log("\n📋 ดึงหน้าแรกของ payment transactions...");
  const firstPage = await getPaymentPage(token, 1, 10);
  
  if (!firstPage?.data?.transactions?.length) {
    console.error("❌ ไม่ได้รับ transactions:", JSON.stringify(firstPage).slice(0, 500));
    return;
  }

  const transactions = firstPage.data.transactions;
  console.log(`\nTotal transactions: ${firstPage.data.pagination?.total_items ?? "?"}`);
  console.log(`Total pages: ${firstPage.data.pagination?.total_pages ?? "?"}`);
  
  // แสดง fields ที่มีใน response
  const sample = transactions[0];
  console.log("\n📌 Fields ที่มีใน API response (transaction แรก):");
  const fields = Object.keys(sample);
  console.log(fields.join(", "));
  
  // แสดง payment_time ของ 10 transactions แรก
  console.log("\n📊 payment_time ของ 10 transactions แรก:");
  for (const tx of transactions) {
    console.log(`  payment_id=${tx.payment_id} | payment_date=${tx.payment_date} | payment_time=${JSON.stringify(tx.payment_time)} | created_by=${tx.created_by}`);
  }

  // ค้นหา transactions ที่ payment_time เป็น null ใน page แรก
  const nullPt = transactions.filter(tx => tx.payment_time === null || tx.payment_time === undefined);
  const hasPt = transactions.filter(tx => tx.payment_time !== null && tx.payment_time !== undefined);
  
  console.log(`\n📈 ใน 10 transactions แรก:`);
  console.log(`  - payment_time มีค่า: ${hasPt.length}`);
  console.log(`  - payment_time เป็น null/undefined: ${nullPt.length}`);

  // ดึงหน้าสุดท้ายเพื่อดูข้อมูลเก่าที่สุด
  const totalPages = firstPage.data.pagination?.total_pages ?? 1;
  console.log(`\n📋 ดึงหน้าสุดท้าย (page ${totalPages}) เพื่อดูข้อมูลเก่าที่สุด...`);
  const lastPage = await getPaymentPage(token, totalPages, 10);
  
  if (lastPage?.data?.transactions?.length) {
    console.log("\n📊 payment_time ของ 10 transactions สุดท้าย (เก่าที่สุด):");
    for (const tx of lastPage.data.transactions) {
      console.log(`  payment_id=${tx.payment_id} | payment_date=${tx.payment_date} | payment_time=${JSON.stringify(tx.payment_time)} | created_by=${tx.created_by}`);
    }
    
    const nullPtLast = lastPage.data.transactions.filter(tx => tx.payment_time === null || tx.payment_time === undefined);
    const hasPtLast = lastPage.data.transactions.filter(tx => tx.payment_time !== null && tx.payment_time !== undefined);
    console.log(`\n📈 ใน 10 transactions สุดท้าย:`);
    console.log(`  - payment_time มีค่า: ${hasPtLast.length}`);
    console.log(`  - payment_time เป็น null/undefined: ${nullPtLast.length}`);
  }

  // ดึงหน้ากลางๆ เพื่อดูข้อมูลปี 2025
  const midPage = Math.floor(totalPages / 2);
  console.log(`\n📋 ดึงหน้ากลาง (page ${midPage}) เพื่อดูข้อมูลปี 2025...`);
  const midPageData = await getPaymentPage(token, midPage, 20);
  
  if (midPageData?.data?.transactions?.length) {
    const nullPtMid = midPageData.data.transactions.filter(tx => tx.payment_time === null || tx.payment_time === undefined);
    const hasPtMid = midPageData.data.transactions.filter(tx => tx.payment_time !== null && tx.payment_time !== undefined);
    console.log(`\n📈 ใน page ${midPage} (${midPageData.data.transactions.length} transactions):`);
    console.log(`  - payment_time มีค่า: ${hasPtMid.length}`);
    console.log(`  - payment_time เป็น null/undefined: ${nullPtMid.length}`);
    
    // แสดงตัวอย่าง null
    if (nullPtMid.length > 0) {
      console.log("\n  ตัวอย่าง transactions ที่ payment_time เป็น null:");
      for (const tx of nullPtMid.slice(0, 3)) {
        console.log(`    payment_id=${tx.payment_id} | payment_date=${tx.payment_date} | payment_time=${JSON.stringify(tx.payment_time)}`);
      }
    }
  }

  console.log("\n✅ Probe เสร็จสิ้น");
}

main().catch(err => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});

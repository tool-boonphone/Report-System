/**
 * ดึง payment transactions ของสัญญา CT0225-SRI001-9289-01 (id=9289) จาก FF365 API
 */
const url = process.env.FASTFONE_API_URL;
const user = process.env.FASTFONE_API_USERNAME;
const pass = process.env.FASTFONE_API_PASSWORD;

const r = await fetch(url + 'api/v1/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: user, password: pass })
});
const d = await r.json();
const tok = d?.data?.access_token;
console.log('Login:', tok ? 'OK' : 'FAIL');

const headers = { Authorization: 'Bearer ' + tok };

// ดึง payment transactions ทั้งหมดของ contract 9289 (limit สูงๆ เพื่อดึงครั้งเดียว)
const res = await fetch(url + 'api/v1/payment?action=transactions&contract_id=9289&limit=100', { headers });
const json = await res.json();
const payments = json?.data?.transactions ?? [];
const pagination = json?.data?.pagination ?? {};

console.log(`\nรายการชำระ: ${payments.length} รายการ (total: ${pagination.total_records ?? '?'})`);
console.log('\n#  | payment_id | วันที่ชำระ   | receipt_no                        | เงินต้น  | ดอกเบี้ย | ค่าดำเนินการ | ค่าปรับ | ยอดรวม  | สถานะ         | created_at          | updated_at');
console.log('-'.repeat(180));

for (let i = 0; i < payments.length; i++) {
  const p = payments[i];
  const no = String(i+1).padStart(2);
  const pid = String(p.payment_id).padEnd(10);
  const date = String(p.payment_date).padEnd(12);
  const receipt = String(p.receipt_no ?? '-').padEnd(35);
  const prin = String(p.principal_paid ?? 0).padStart(8);
  const int = String(p.interest_paid ?? 0).padStart(9);
  const fee = String(p.fee_paid ?? 0).padStart(12);
  const pen = String(p.penalty_paid ?? 0).padStart(8);
  const total = String(p.total_paid_amount ?? 0).padStart(8);
  const status = String(p.payment_status ?? '-').padEnd(14);
  const createdAt = String(p.created_at ?? '-').padEnd(20);
  const updatedAt = String(p.updated_at ?? '-');
  console.log(`${no} | ${pid} | ${date} | ${receipt} | ${prin} | ${int} | ${fee} | ${pen} | ${total} | ${status} | ${createdAt} | ${updatedAt}`);
}

// เปรียบเทียบกับ installments
console.log('\n=== INSTALLMENTS จาก contract detail ===');
const detailRes = await fetch(url + 'api/v1/contract?action=detail&id=9289', { headers });
const detailJson = await detailRes.json();
const installments = detailJson?.data?.contract?.installments ?? [];

console.log(`\nงวด | ครบกำหนด    | ยอดงวด | ชำระแล้ว | คงเหลือ | สถานะ          | updated_by    | updated_at`);
console.log('-'.repeat(120));
for (const inst of installments) {
  const no = String(inst.no).padEnd(4);
  const due = String(inst.due_date).padEnd(12);
  const amt = String(inst.amount).padStart(7);
  const paid = String(inst.paid).padStart(9);
  const bal = String(inst.balance).padStart(8);
  const status = String(inst.status).padEnd(16);
  const updBy = String(inst.updated_by ?? '-').padEnd(14);
  const updAt = String(inst.updated_at ?? '-');
  console.log(`${no} | ${due} | ${amt} | ${paid} | ${bal} | ${status} | ${updBy} | ${updAt}`);
}

console.log('\n=== สรุป ===');
console.log(`Installments: ${installments.length} งวด`);
console.log(`Payment transactions: ${payments.length} รายการ`);
console.log('\nหมายเหตุ: payment transactions ไม่มี field updated_by');
console.log('ชื่อผู้บันทึกที่ถูกต้องอยู่ใน installments[].updated_by เท่านั้น');

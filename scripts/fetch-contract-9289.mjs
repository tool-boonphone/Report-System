/**
 * ดึงข้อมูลจริงทั้งหมดของสัญญา CT0225-SRI001-9289-01 จาก FF365 API
 * contract_id = 9289
 */
const url = process.env.FASTFONE_API_URL;
const user = process.env.FASTFONE_API_USERNAME;
const pass = process.env.FASTFONE_API_PASSWORD;

async function login() {
  const r = await fetch(url + 'api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user, password: pass })
  });
  const d = await r.json();
  return d?.data?.access_token;
}

function fmt(v) {
  if (v === null || v === undefined) return '-';
  return String(v);
}

async function main() {
  const tok = await login();
  if (!tok) { console.log('Login fail'); return; }
  const headers = { Authorization: 'Bearer ' + tok };
  const base = url + 'api/v1/';

  // ดึง contract detail เพื่อได้ installments + updated_by
  console.log('=== CONTRACT DETAIL: CT0225-SRI001-9289-01 (id=9289) ===\n');
  const detailRes = await fetch(base + 'contract?action=detail&id=9289', { headers });
  const detailJson = await detailRes.json();
  const contract = detailJson?.data?.contract ?? {};

  console.log('สถานะสัญญา:', contract.status);
  console.log('สร้างโดย:', contract.created_by, '| อัปเดตโดย:', contract.updated_by);
  console.log('');

  // แสดง installments พร้อม updated_by
  const installments = contract.installments ?? [];
  console.log(`=== INSTALLMENTS (${installments.length} งวด) ===`);
  console.log('งวด | ครบกำหนด    | ยอดงวด  | ชำระแล้ว | คงเหลือ | ค่าปรับ | ส่วนลด | สถานะ          | updated_by    | updated_at');
  console.log('-'.repeat(130));
  for (const inst of installments) {
    const no = fmt(inst.no).padEnd(4);
    const due = fmt(inst.due_date).padEnd(12);
    const amt = fmt(inst.amount).padStart(8);
    const paid = fmt(inst.paid).padStart(9);
    const bal = fmt(inst.balance).padStart(8);
    const mulct = fmt(inst.mulct).padStart(8);
    const disc = fmt(inst.discount).padStart(7);
    const status = fmt(inst.status).padEnd(16);
    const updBy = fmt(inst.updated_by).padEnd(14);
    const updAt = fmt(inst.updated_at);
    console.log(`${no} | ${due} | ${amt} | ${paid} | ${bal} | ${mulct} | ${disc} | ${status} | ${updBy} | ${updAt}`);
  }

  // ดึง payment transactions ทั้งหมด
  console.log('\n=== PAYMENT TRANSACTIONS (จาก payment?action=transactions) ===');
  let allPayments = [];
  let page = 1;
  while (true) {
    const res = await fetch(base + `payment?action=transactions&contract_id=9289&page=${page}&limit=50`, { headers });
    const json = await res.json();
    const txns = json?.data?.transactions ?? [];
    allPayments = allPayments.concat(txns);
    const pagination = json?.data?.pagination ?? {};
    if (page >= (pagination.total_pages ?? 1)) break;
    page++;
  }

  console.log(`พบรายการชำระ: ${allPayments.length} รายการ`);
  console.log('');
  console.log('payment_id | วันที่ชำระ   | receipt_no                        | เงินต้น  | ดอกเบี้ย | ค่าดำเนินการ | ค่าปรับ | ค่าปลดล็อก | ยอดรวม  | สถานะ          | created_at              | updated_at              | updated_by');
  console.log('-'.repeat(200));
  for (const p of allPayments) {
    const pid = fmt(p.payment_id).padEnd(10);
    const date = fmt(p.payment_date).padEnd(12);
    const receipt = fmt(p.receipt_no).padEnd(35);
    const prin = fmt(p.principal_paid).padStart(8);
    const int = fmt(p.interest_paid).padStart(9);
    const fee = fmt(p.fee_paid).padStart(12);
    const pen = fmt(p.penalty_paid).padStart(8);
    const unlock = fmt(p.unlock_fee_paid).padStart(10);
    const total = fmt(p.total_paid_amount).padStart(8);
    const status = fmt(p.payment_status).padEnd(16);
    const createdAt = fmt(p.created_at).padEnd(24);
    const updatedAt = fmt(p.updated_at).padEnd(24);
    const updBy = fmt(p.updated_by);
    console.log(`${pid} | ${date} | ${receipt} | ${prin} | ${int} | ${fee} | ${pen} | ${unlock} | ${total} | ${status} | ${createdAt} | ${updatedAt} | ${updBy}`);
  }

  // เปรียบเทียบ: installment กี่งวด vs payment กี่รายการ
  console.log('\n=== สรุปเปรียบเทียบ ===');
  console.log(`Installments: ${installments.length} งวด`);
  console.log(`Payment transactions: ${allPayments.length} รายการ`);
  
  // แสดง installments พร้อมจับคู่ payment
  console.log('\n=== จับคู่ installment กับ payment ===');
  for (const inst of installments) {
    const matchedPayments = allPayments.filter(p => {
      // Match by due_date proximity or receipt_no pattern
      const receiptPattern = `-${String(inst.no).padStart(1, '0')}-`;
      return p.receipt_no?.includes(receiptPattern);
    });
    console.log(`งวด ${inst.no} (due: ${inst.due_date}, status: ${inst.status}, updated_by: ${inst.updated_by}):`);
    if (matchedPayments.length > 0) {
      for (const p of matchedPayments) {
        console.log(`  → payment ${p.payment_id} (${p.payment_date}) ${p.total_paid_amount} บาท | receipt: ${p.receipt_no} | updated_by: ${p.updated_by ?? '-'}`);
      }
    } else {
      console.log('  → ไม่พบ payment ที่ตรงกัน');
    }
  }
}

main().catch(console.error);

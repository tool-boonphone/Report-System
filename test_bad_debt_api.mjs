import axios from 'axios';
import mysql from 'mysql2/promise';

// ======= Boonphone =======
const bpUrl = process.env.BOONPHONE_API_URL || 'https://boonphone.demosiam.com/';
const bpUser = process.env.BOONPHONE_API_USERNAME;
const bpPass = process.env.BOONPHONE_API_PASSWORD;

// ======= FF365 =======
const ffUrl = process.env.FASTFONE_API_URL || 'https://partner.fastfone365.co.th/';
const ffUser = process.env.FASTFONE_API_USERNAME;
const ffPass = process.env.FASTFONE_API_PASSWORD;

async function scanPayments(baseUrl, username, password, label) {
  const loginRes = await axios.post(baseUrl + 'api/v1/auth/login', { username, password });
  const token = loginRes.data?.data?.access_token;
  console.log(`\n=== ${label} ===`);

  let found = [];
  let allStatuses = new Set();

  for (let page = 1; page <= 30; page++) {
    const payRes = await axios.get(baseUrl + 'api/v1/payment', {
      params: { action: 'transactions', page, per_page: 100 },
      headers: { Authorization: 'Bearer ' + token }
    });
    const items = payRes.data?.data?.transactions || [];
    items.forEach(i => allStatuses.add(i.payment_status));
    const badDebt = items.filter(i => Number(i.bad_debt_amount) > 0);
    found.push(...badDebt);

    const hasNext = payRes.data?.data?.pagination?.has_next;
    if (!hasNext) {
      console.log(`Scanned ${page} pages`);
      break;
    }
  }

  console.log('Unique payment_status values:', [...allStatuses]);
  console.log('Payments with bad_debt_amount > 0:', found.length);
  if (found.length > 0) {
    console.log('Sample bad_debt payment:', JSON.stringify(found[0], null, 2).substring(0, 600));
  }
}

// ตรวจสอบ FF365 contract detail ของสัญญาหนี้เสีย — หา pattern ขายเครื่อง
async function checkFF365BadDebtPayments() {
  const loginRes = await axios.post(ffUrl + 'api/v1/auth/login', { username: ffUser, password: ffPass });
  const token = loginRes.data?.data?.access_token;
  console.log('\n=== FF365 Bad Debt Contract Detail (installments) ===');

  // ดู contract 23556 ที่เป็นหนี้เสีย — ดู payment transactions ของมัน
  const payRes = await axios.get(ffUrl + 'api/v1/payment', {
    params: { action: 'transactions', contract_id: 23556, per_page: 50 },
    headers: { Authorization: 'Bearer ' + token }
  });
  const items = payRes.data?.data?.transactions || [];
  console.log('Payments for contract 23556 (bad debt):', items.length);
  if (items.length > 0) {
    console.log('Payment statuses:', [...new Set(items.map(i => i.payment_status))]);
    console.log('bad_debt_amount values:', [...new Set(items.map(i => i.bad_debt_amount))]);
    console.log('Payments:', JSON.stringify(items.map(i => ({
      payment_id: i.payment_id,
      payment_date: i.payment_date,
      payment_status: i.payment_status,
      bad_debt_amount: i.bad_debt_amount,
      total_paid_amount: i.total_paid_amount,
      remark: i.remark
    })), null, 2).substring(0, 1000));
  }
}

try {
  await scanPayments(bpUrl, bpUser, bpPass, 'Boonphone');
  await checkFF365BadDebtPayments();
} catch(e) {
  console.error('Error:', e.message, e.response?.status);
}

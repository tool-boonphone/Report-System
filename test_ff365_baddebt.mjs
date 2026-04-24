import axios from 'axios';

const ffUrl = process.env.FASTFONE_API_URL || 'https://partner.fastfone365.co.th/';
const ffUser = process.env.FASTFONE_API_USERNAME;
const ffPass = process.env.FASTFONE_API_PASSWORD;

const loginRes = await axios.post(ffUrl + 'api/v1/auth/login', { username: ffUser, password: ffPass });
const token = loginRes.data?.data?.access_token;
console.log('Login OK:', !!token);

// ดู payment transactions ของ contract 23556 (หนี้เสีย)
const payRes = await axios.get(ffUrl + 'api/v1/payment', {
  params: { action: 'transactions', contract_id: 23556, per_page: 50 },
  headers: { Authorization: 'Bearer ' + token }
});

const items = payRes.data?.data?.transactions || [];
console.log('\nPayments for contract 23556 (bad debt):', items.length);
if (items.length > 0) {
  console.log('Payment statuses:', [...new Set(items.map(i => i.payment_status))]);
  console.log('bad_debt_amount values:', [...new Set(items.map(i => i.bad_debt_amount))]);
  console.log('All payments:');
  items.forEach(i => console.log(JSON.stringify({
    payment_id: i.payment_id,
    payment_date: i.payment_date,
    payment_status: i.payment_status,
    bad_debt_amount: i.bad_debt_amount,
    total_paid_amount: i.total_paid_amount,
    remark: i.remark
  })));
} else {
  console.log('No payments found for this contract');
  console.log('Full response:', JSON.stringify(payRes.data).substring(0, 500));
}

// ลองดู FF365 payment ที่มี bad_debt_amount > 0 ทั้งหมด
console.log('\n=== Scanning all FF365 payments for bad_debt_amount > 0 ===');
let foundBadDebt = [];
for (let page = 1; page <= 10; page++) {
  const r = await axios.get(ffUrl + 'api/v1/payment', {
    params: { action: 'transactions', page, per_page: 100 },
    headers: { Authorization: 'Bearer ' + token }
  });
  const txns = r.data?.data?.transactions || [];
  const bad = txns.filter(i => Number(i.bad_debt_amount) > 0);
  foundBadDebt.push(...bad);
  if (!r.data?.data?.pagination?.has_next) {
    console.log('Scanned', page, 'pages, no more');
    break;
  }
}
console.log('Total bad_debt_amount > 0 found (first 10 pages):', foundBadDebt.length);
if (foundBadDebt.length > 0) {
  console.log('Sample:', JSON.stringify(foundBadDebt[0]));
}

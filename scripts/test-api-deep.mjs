/**
 * Deep explore FF365 API for contract 9289 - find where updated_by for payments comes from
 */
const url = process.env.FASTFONE_API_URL;
const user = process.env.FASTFONE_API_USERNAME;
const pass = process.env.FASTFONE_API_PASSWORD;

async function main() {
  const r = await fetch(url + 'api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user, password: pass })
  });
  const d = await r.json();
  const tok = d?.data?.access_token;
  if (!tok) { console.log('Login fail:', JSON.stringify(d)); return; }
  console.log('Login OK\n');

  const headers = { Authorization: 'Bearer ' + tok };
  const base = url + 'api/v1/';

  // 1. Contract detail - check created_by/updated_by
  console.log('=== 1. Contract detail (contract 9289) ===');
  const detailRes = await fetch(base + 'contract?action=detail&id=9289', { headers });
  const detailJson = await detailRes.json();
  const contract = detailJson?.data?.contract ?? {};
  console.log('contract.created_by:', contract.created_by);
  console.log('contract.updated_by:', contract.updated_by);
  console.log('contract keys (top level):', Object.keys(contract).join(', '));

  // 2. Check installments in contract detail
  if (contract.installments) {
    console.log('\n=== 2. Installments in contract detail ===');
    const inst = Array.isArray(contract.installments) ? contract.installments : [];
    console.log('Count:', inst.length);
    if (inst.length > 0) {
      console.log('First installment keys:', Object.keys(inst[0]).join(', '));
      const adminFields = Object.keys(inst[0]).filter(k =>
        k.includes('admin') || k.includes('user') || k.includes('_by') || k.includes('staff') || k.includes('name')
      );
      console.log('Admin fields:', adminFields.join(', '));
      if (adminFields.length) {
        for (const f of adminFields) console.log(' ', f, '=', inst[0][f]);
      }
      // Show all installments with payment info
      for (const i of inst.slice(0, 5)) {
        const adminVals = adminFields.map(f => f + '=' + i[f]).join(', ');
        console.log(`  period ${i.period_no || i.installment_no}: paid=${i.paid_amount || i.total_paid_amount} | ${adminVals}`);
      }
    }
  }

  // 3. Check payments in contract detail
  if (contract.payments) {
    console.log('\n=== 3. Payments in contract detail ===');
    const pmts = Array.isArray(contract.payments) ? contract.payments : [];
    console.log('Count:', pmts.length);
    if (pmts.length > 0) {
      console.log('First payment keys:', Object.keys(pmts[0]).join(', '));
      const adminFields = Object.keys(pmts[0]).filter(k =>
        k.includes('admin') || k.includes('user') || k.includes('_by') || k.includes('staff') || k.includes('name')
      );
      console.log('Admin fields:', adminFields.join(', '));
      if (adminFields.length) {
        for (const p of pmts.slice(0, 5)) {
          const adminVals = adminFields.map(f => f + '=' + p[f]).join(', ');
          console.log(`  payment ${p.payment_id}: ${p.total_paid_amount} | ${adminVals}`);
        }
      }
    }
  }

  // 4. Check payment transactions with different params
  console.log('\n=== 4. Payment transactions for contract 9289 ===');
  const payRes = await fetch(base + 'payment?action=transactions&contract_id=9289&limit=10', { headers });
  const payJson = await payRes.json();
  const payments = payJson?.data?.transactions ?? [];
  console.log('Count:', payments.length);
  if (payments.length > 0) {
    console.log('All keys:', Object.keys(payments[0]).join(', '));
    for (const p of payments) {
      console.log(`  payment_id=${p.payment_id} date=${p.payment_date} amount=${p.total_paid_amount} created_at=${p.created_at} updated_at=${p.updated_at}`);
    }
  }

  // 5. Try installment with different actions
  console.log('\n=== 5. Trying installment endpoints ===');
  const instActions = ['detail', 'payment', 'payments', 'paid', 'paid-history'];
  for (const action of instActions) {
    const res = await fetch(base + `installment?action=${action}&contract_id=9289&limit=3`, { headers });
    const json = await res.json();
    console.log(`installment?action=${action}: status=${json?.status_code} msg=${json?.message}`);
    if (json?.status_code === 200 && json?.data) {
      const arr = Array.isArray(json.data) ? json.data : Object.values(json.data).find(v => Array.isArray(v));
      if (arr && arr.length > 0) {
        console.log('  keys:', Object.keys(arr[0]).join(', '));
      }
    }
  }
}

main().catch(console.error);

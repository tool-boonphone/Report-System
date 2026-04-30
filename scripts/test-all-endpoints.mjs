/**
 * ทดสอบทุก endpoint ที่เป็นไปได้ใน FF365 API สำหรับสัญญา CT0225-SRI001-9289-01 (id=9289)
 */
const baseUrl = process.env.FASTFONE_API_URL;
const user = process.env.FASTFONE_API_USERNAME;
const pass = process.env.FASTFONE_API_PASSWORD;

// Login
const loginRes = await fetch(baseUrl + 'api/v1/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: user, password: pass })
});
const loginJson = await loginRes.json();
const tok = loginJson?.data?.access_token;
if (!tok) { console.error('Login FAILED'); process.exit(1); }
console.log('✅ Login OK\n');

const headers = { Authorization: 'Bearer ' + tok };
const CONTRACT_ID = 9289;
const CONTRACT_NO = 'CT0225-SRI001-9289-01';

async function test(label, path) {
  try {
    const res = await fetch(baseUrl + path, { headers });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = null; }
    
    const status = res.status;
    const success = json?.success;
    const message = json?.message ?? '';
    
    if (status === 200 && success !== false) {
      // Count data items
      const data = json?.data;
      let summary = '';
      if (data) {
        const keys = Object.keys(data);
        for (const k of keys) {
          if (Array.isArray(data[k])) summary += `${k}[${data[k].length}] `;
          else if (typeof data[k] === 'object' && data[k] !== null) summary += `${k}{} `;
        }
      }
      console.log(`✅ ${status} | ${label}`);
      console.log(`   ${summary || JSON.stringify(data).substring(0, 100)}`);
      return json;
    } else {
      console.log(`❌ ${status} | ${label} → ${message}`);
      return null;
    }
  } catch (e) {
    console.log(`💥 ERR | ${label} → ${e.message.substring(0, 60)}`);
    return null;
  }
}

console.log('=== AUTH ===');
await test('auth/me', 'api/v1/auth/me');
await test('auth/profile', 'api/v1/auth/profile');

console.log('\n=== CONTRACT ===');
await test('contract?action=list', `api/v1/contract?action=list&limit=1`);
await test('contract?action=detail&id', `api/v1/contract?action=detail&id=${CONTRACT_ID}`);
await test('contract?action=detail&contract_no', `api/v1/contract?action=detail&contract_no=${CONTRACT_NO}`);
await test('contract?action=installments&id', `api/v1/contract?action=installments&id=${CONTRACT_ID}`);
await test('contract?action=installments&contract_id', `api/v1/contract?action=installments&contract_id=${CONTRACT_ID}`);
await test('contract?action=payments&id', `api/v1/contract?action=payments&id=${CONTRACT_ID}`);
await test('contract?action=payments&contract_id', `api/v1/contract?action=payments&contract_id=${CONTRACT_ID}`);
await test('contract?action=history&id', `api/v1/contract?action=history&id=${CONTRACT_ID}`);
await test('contract?action=log&id', `api/v1/contract?action=log&id=${CONTRACT_ID}`);
await test('contract?action=activity&id', `api/v1/contract?action=activity&id=${CONTRACT_ID}`);
await test('contract?action=transactions&id', `api/v1/contract?action=transactions&id=${CONTRACT_ID}`);
await test('contract?action=summary&id', `api/v1/contract?action=summary&id=${CONTRACT_ID}`);
await test('contract?action=info&id', `api/v1/contract?action=info&id=${CONTRACT_ID}`);
await test('contract?action=status&id', `api/v1/contract?action=status&id=${CONTRACT_ID}`);

console.log('\n=== INSTALLMENT ===');
await test('installment?action=list', `api/v1/installment?action=list&limit=1`);
await test('installment?action=detail&contract_id', `api/v1/installment?action=detail&contract_id=${CONTRACT_ID}`);
await test('installment?action=detail&id', `api/v1/installment?action=detail&id=${CONTRACT_ID}`);
await test('installment?action=history&contract_id', `api/v1/installment?action=history&contract_id=${CONTRACT_ID}`);
await test('installment?action=transactions&contract_id', `api/v1/installment?action=transactions&contract_id=${CONTRACT_ID}`);
await test('installment?action=payments&contract_id', `api/v1/installment?action=payments&contract_id=${CONTRACT_ID}`);
await test('installment?action=log&contract_id', `api/v1/installment?action=log&contract_id=${CONTRACT_ID}`);

console.log('\n=== PAYMENT ===');
await test('payment?action=transactions (no filter)', `api/v1/payment?action=transactions&limit=1`);
await test('payment?action=transactions&contract_id', `api/v1/payment?action=transactions&contract_id=${CONTRACT_ID}&limit=50`);
await test('payment?action=transactions&contract_no', `api/v1/payment?action=transactions&contract_no=${CONTRACT_NO}&limit=50`);
await test('payment?action=list', `api/v1/payment?action=list&limit=1`);
await test('payment?action=list&contract_id', `api/v1/payment?action=list&contract_id=${CONTRACT_ID}`);
await test('payment?action=detail&contract_id', `api/v1/payment?action=detail&contract_id=${CONTRACT_ID}`);
await test('payment?action=history&contract_id', `api/v1/payment?action=history&contract_id=${CONTRACT_ID}`);
await test('payment?action=history&id', `api/v1/payment?action=history&id=${CONTRACT_ID}`);
await test('payment?action=log&contract_id', `api/v1/payment?action=log&contract_id=${CONTRACT_ID}`);
await test('payment?action=summary&contract_id', `api/v1/payment?action=summary&contract_id=${CONTRACT_ID}`);
await test('payment?action=info&contract_id', `api/v1/payment?action=info&contract_id=${CONTRACT_ID}`);
await test('payment?action=receipt&contract_id', `api/v1/payment?action=receipt&contract_id=${CONTRACT_ID}`);

console.log('\n=== DEBT ===');
await test('debt?action=list', `api/v1/debt?action=list&limit=1`);
await test('debt?action=detail&contract_id', `api/v1/debt?action=detail&contract_id=${CONTRACT_ID}`);
await test('debt?action=history&contract_id', `api/v1/debt?action=history&contract_id=${CONTRACT_ID}`);
await test('debt?action=info&contract_id', `api/v1/debt?action=info&contract_id=${CONTRACT_ID}`);
await test('debt?action=log&contract_id', `api/v1/debt?action=log&contract_id=${CONTRACT_ID}`);
await test('debt?action=transactions&contract_id', `api/v1/debt?action=transactions&contract_id=${CONTRACT_ID}`);

console.log('\n=== REPORT ===');
await test('report?action=list', `api/v1/report?action=list&limit=1`);
await test('report?action=payment', `api/v1/report?action=payment&contract_id=${CONTRACT_ID}`);
await test('report?action=installment', `api/v1/report?action=installment&contract_id=${CONTRACT_ID}`);
await test('report?action=contract', `api/v1/report?action=contract&id=${CONTRACT_ID}`);

console.log('\n=== TRANSACTION ===');
await test('transaction?action=list', `api/v1/transaction?action=list&limit=1`);
await test('transaction?action=detail&contract_id', `api/v1/transaction?action=detail&contract_id=${CONTRACT_ID}`);
await test('transaction?action=history&contract_id', `api/v1/transaction?action=history&contract_id=${CONTRACT_ID}`);

console.log('\n=== CUSTOMER ===');
await test('customer?action=list', `api/v1/customer?action=list&limit=1`);
await test('customer?action=detail&contract_id', `api/v1/customer?action=detail&contract_id=${CONTRACT_ID}`);

console.log('\n=== MISC ===');
await test('order?action=list', `api/v1/order?action=list&limit=1`);
await test('order?action=detail&id', `api/v1/order?action=detail&id=${CONTRACT_ID}`);
await test('log?action=list', `api/v1/log?action=list&contract_id=${CONTRACT_ID}`);
await test('activity?action=list', `api/v1/activity?action=list&contract_id=${CONTRACT_ID}`);
await test('audit?action=list', `api/v1/audit?action=list&contract_id=${CONTRACT_ID}`);

console.log('\n✅ Done');

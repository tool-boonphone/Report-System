/**
 * ดึงข้อมูลทุก endpoint ที่เกี่ยวกับสัญญา CT0225-SRI001-9289-01 (id=9289) จาก FF365 API
 */
const url = process.env.FASTFONE_API_URL;
const user = process.env.FASTFONE_API_USERNAME;
const pass = process.env.FASTFONE_API_PASSWORD;

// Login
const loginRes = await fetch(url + 'api/v1/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: user, password: pass })
});
const loginJson = await loginRes.json();
const tok = loginJson?.data?.access_token;
if (!tok) { console.error('Login FAILED', loginJson); process.exit(1); }
console.log('✅ Login OK\n');

const headers = { Authorization: 'Bearer ' + tok };
const CONTRACT_ID = 9289;

// ─── Helper ───────────────────────────────────────────────────────────────────
async function fetchEndpoint(label, path) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`📌 ${label}`);
  console.log(`   URL: ${url}${path}`);
  console.log('='.repeat(80));
  try {
    const res = await fetch(url + path, { headers });
    const json = await res.json();
    console.log(JSON.stringify(json, null, 2));
    return json;
  } catch (e) {
    console.log('❌ ERROR:', e.message);
    return null;
  }
}

// ─── 1. Contract Detail ───────────────────────────────────────────────────────
await fetchEndpoint(
  'CONTRACT DETAIL (contract?action=detail)',
  `api/v1/contract?action=detail&id=${CONTRACT_ID}`
);

// ─── 2. Contract History / Log ────────────────────────────────────────────────
await fetchEndpoint(
  'CONTRACT HISTORY (contract?action=history)',
  `api/v1/contract?action=history&id=${CONTRACT_ID}`
);

// ─── 3. Contract Log ──────────────────────────────────────────────────────────
await fetchEndpoint(
  'CONTRACT LOG (contract?action=log)',
  `api/v1/contract?action=log&id=${CONTRACT_ID}`
);

// ─── 4. Payment by contract_id ────────────────────────────────────────────────
await fetchEndpoint(
  'PAYMENT TRANSACTIONS (payment?action=transactions&contract_id)',
  `api/v1/payment?action=transactions&contract_id=${CONTRACT_ID}&limit=50&page=1`
);

// ─── 5. Payment by contract_no ────────────────────────────────────────────────
await fetchEndpoint(
  'PAYMENT by contract_no (payment?action=transactions&contract_no)',
  `api/v1/payment?action=transactions&contract_no=CT0225-SRI001-9289-01&limit=50&page=1`
);

// ─── 6. Installment detail ────────────────────────────────────────────────────
await fetchEndpoint(
  'INSTALLMENT DETAIL (installment?action=detail)',
  `api/v1/installment?action=detail&contract_id=${CONTRACT_ID}`
);

// ─── 7. Installment history ───────────────────────────────────────────────────
await fetchEndpoint(
  'INSTALLMENT HISTORY (installment?action=history)',
  `api/v1/installment?action=history&contract_id=${CONTRACT_ID}`
);

// ─── 8. Installment list ──────────────────────────────────────────────────────
await fetchEndpoint(
  'INSTALLMENT LIST (installment?action=list)',
  `api/v1/installment?action=list&contract_id=${CONTRACT_ID}`
);

// ─── 9. Payment detail ────────────────────────────────────────────────────────
await fetchEndpoint(
  'PAYMENT DETAIL (payment?action=detail)',
  `api/v1/payment?action=detail&contract_id=${CONTRACT_ID}`
);

// ─── 10. Payment list ─────────────────────────────────────────────────────────
await fetchEndpoint(
  'PAYMENT LIST (payment?action=list)',
  `api/v1/payment?action=list&contract_id=${CONTRACT_ID}`
);

// ─── 11. Payment history ──────────────────────────────────────────────────────
await fetchEndpoint(
  'PAYMENT HISTORY (payment?action=history)',
  `api/v1/payment?action=history&contract_id=${CONTRACT_ID}`
);

// ─── 12. Debt info ────────────────────────────────────────────────────────────
await fetchEndpoint(
  'DEBT INFO (debt?action=detail)',
  `api/v1/debt?action=detail&contract_id=${CONTRACT_ID}`
);

// ─── 13. Debt history ─────────────────────────────────────────────────────────
await fetchEndpoint(
  'DEBT HISTORY (debt?action=history)',
  `api/v1/debt?action=history&contract_id=${CONTRACT_ID}`
);

console.log('\n\n✅ Done fetching all endpoints for contract 9289');

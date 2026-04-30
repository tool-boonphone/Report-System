/**
 * Test FF365 API endpoints for contract 9289 to find updated_by / admin fields
 */
const url = process.env.FASTFONE_API_URL;
const user = process.env.FASTFONE_API_USERNAME;
const pass = process.env.FASTFONE_API_PASSWORD;

async function main() {
  // Login
  const r = await fetch(url + 'api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user, password: pass })
  });
  const d = await r.json();
  const tok = d?.data?.access_token;
  if (!tok) { console.log('Login fail:', JSON.stringify(d)); return; }
  console.log('Login OK');

  const headers = { Authorization: 'Bearer ' + tok };
  const base = url + 'api/v1/';

  // Test multiple endpoints for contract 9289
  const endpoints = [
    'installment?action=history&contract_id=9289&limit=5',
    'installment?action=list&contract_id=9289&limit=5',
    'payment?action=transactions&contract_id=9289&limit=5',
    'contract?action=detail&id=9289',
    'payment?action=list&contract_id=9289&limit=5',
    'payment?action=history&contract_id=9289&limit=5',
  ];

  for (const ep of endpoints) {
    try {
      const res = await fetch(base + ep, { headers });
      const json = await res.json();
      const data = json?.data;
      const keys = data ? Object.keys(data) : [];
      console.log('\n--- ' + ep);
      console.log('status:', json?.status_code, '| data keys:', keys.join(', '));

      // Find array in data
      const arr = Array.isArray(data) ? data : (data ? Object.values(data).find(v => Array.isArray(v)) : null);
      if (arr && arr.length > 0) {
        const item = arr[0];
        console.log('first item keys:', Object.keys(item).join(', '));
        // Check for admin/user/staff/by fields
        const adminFields = Object.keys(item).filter(k =>
          k.includes('admin') || k.includes('user') || k.includes('_by') ||
          k.includes('staff') || k.includes('recorder') || k.includes('created_name') ||
          k.includes('updated_name') || k.includes('biller')
        );
        if (adminFields.length) {
          console.log('*** ADMIN FIELDS FOUND:', adminFields.join(', '));
          for (const f of adminFields) console.log('  ', f, '=', item[f]);
        } else {
          console.log('(no admin/user fields found)');
        }
      } else if (data && !Array.isArray(data)) {
        // Might be a single object (contract detail)
        const adminFields = Object.keys(data).filter(k =>
          k.includes('admin') || k.includes('user') || k.includes('_by') ||
          k.includes('staff') || k.includes('recorder')
        );
        if (adminFields.length) {
          console.log('*** ADMIN FIELDS IN ROOT:', adminFields.join(', '));
        }
        // Check nested
        for (const [k, v] of Object.entries(data)) {
          if (v && typeof v === 'object' && !Array.isArray(v)) {
            const nested = Object.keys(v).filter(nk =>
              nk.includes('admin') || nk.includes('user') || nk.includes('_by') || nk.includes('staff')
            );
            if (nested.length) console.log('  nested in', k, ':', nested.join(', '));
          }
        }
      }
    } catch (e) {
      console.log('Error for', ep, ':', e.message);
    }
  }
}

main().catch(console.error);

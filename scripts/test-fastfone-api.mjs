/**
 * Test Fastfone365 API connectivity
 * Tests: login, partners, contracts, installments, payments
 */
import https from 'https';

const BASE_URL = 'https://partner.fastfone365.co.th/';
const USERNAME = 'reportfastfone';
const PASSWORD = 'F@stfone365';

async function fetchJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const reqOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
      timeout: 20000,
    };

    const req = https.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });

    if (options.body) req.write(options.body);
    req.end();
  });
}

async function main() {
  console.log('=== Fastfone365 API Test ===\n');
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Username: ${USERNAME}\n`);

  // 1. Test Login
  console.log('--- 1. Testing Login ---');
  let token = null;
  try {
    const loginRes = await fetchJson(`${BASE_URL}api/v1/auth/login`, {
      method: 'POST',
      body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
    });
    console.log(`Status: ${loginRes.status}`);
    if (loginRes.status === 200 && loginRes.body?.data?.access_token) {
      token = loginRes.body.data.access_token;
      console.log('✅ Login SUCCESS');
      console.log(`   Token: ${token.substring(0, 30)}...`);
      if (loginRes.body.data.expires_in) {
        console.log(`   Expires in: ${loginRes.body.data.expires_in}s`);
      }
    } else {
      console.log('❌ Login FAILED');
      console.log('   Response:', JSON.stringify(loginRes.body, null, 2));
      return;
    }
  } catch (e) {
    console.log('❌ Login ERROR:', e.message);
    return;
  }

  const authHeaders = { Authorization: `Bearer ${token}` };

  // 2. Test Partners
  console.log('\n--- 2. Testing GET /api/v1/partners ---');
  try {
    const res = await fetchJson(`${BASE_URL}api/v1/partners?page=1&limit=5`, { headers: authHeaders });
    console.log(`Status: ${res.status}`);
    if (res.status === 200 && res.body?.success) {
      const data = res.body.data;
      const items = Array.isArray(data) ? data : (data?.data || data?.items || data?.results || []);
      console.log(`✅ Partners SUCCESS — got ${items.length} items`);
      if (items.length > 0) console.log('   Sample:', JSON.stringify(items[0]).substring(0, 150));
      // Check pagination
      const total = data?.total || data?.count || res.body?.total;
      if (total) console.log(`   Total: ${total}`);
    } else {
      console.log('❌ Partners FAILED:', JSON.stringify(res.body).substring(0, 200));
    }
  } catch (e) {
    console.log('❌ Partners ERROR:', e.message);
  }

  // 3. Test Contracts
  console.log('\n--- 3. Testing GET /api/v1/contracts ---');
  try {
    const res = await fetchJson(`${BASE_URL}api/v1/contracts?page=1&limit=5`, { headers: authHeaders });
    console.log(`Status: ${res.status}`);
    if (res.status === 200 && res.body?.success) {
      const data = res.body.data;
      const items = Array.isArray(data) ? data : (data?.data || data?.items || data?.results || []);
      console.log(`✅ Contracts SUCCESS — got ${items.length} items`);
      if (items.length > 0) {
        const sample = items[0];
        console.log('   Sample keys:', Object.keys(sample).join(', '));
        console.log('   Sample:', JSON.stringify(sample).substring(0, 200));
      }
      const total = data?.total || data?.count || res.body?.total;
      if (total) console.log(`   Total: ${total}`);
    } else {
      console.log('❌ Contracts FAILED:', JSON.stringify(res.body).substring(0, 200));
    }
  } catch (e) {
    console.log('❌ Contracts ERROR:', e.message);
  }

  // 4. Test Customers
  console.log('\n--- 4. Testing GET /api/v1/customers ---');
  try {
    const res = await fetchJson(`${BASE_URL}api/v1/customers?page=1&limit=5`, { headers: authHeaders });
    console.log(`Status: ${res.status}`);
    if (res.status === 200 && res.body?.success) {
      const data = res.body.data;
      const items = Array.isArray(data) ? data : (data?.data || data?.items || data?.results || []);
      console.log(`✅ Customers SUCCESS — got ${items.length} items`);
      if (items.length > 0) console.log('   Sample keys:', Object.keys(items[0]).join(', '));
      const total = data?.total || data?.count || res.body?.total;
      if (total) console.log(`   Total: ${total}`);
    } else {
      console.log('❌ Customers FAILED:', JSON.stringify(res.body).substring(0, 200));
    }
  } catch (e) {
    console.log('❌ Customers ERROR:', e.message);
  }

  // 5. Test Installments (try first contract)
  console.log('\n--- 5. Testing GET /api/v1/installments ---');
  try {
    const res = await fetchJson(`${BASE_URL}api/v1/installments?page=1&limit=5`, { headers: authHeaders });
    console.log(`Status: ${res.status}`);
    if (res.status === 200 && res.body?.success) {
      const data = res.body.data;
      const items = Array.isArray(data) ? data : (data?.data || data?.items || data?.results || []);
      console.log(`✅ Installments SUCCESS — got ${items.length} items`);
      if (items.length > 0) console.log('   Sample keys:', Object.keys(items[0]).join(', '));
      const total = data?.total || data?.count || res.body?.total;
      if (total) console.log(`   Total: ${total}`);
    } else {
      console.log('❌ Installments FAILED:', JSON.stringify(res.body).substring(0, 200));
    }
  } catch (e) {
    console.log('❌ Installments ERROR:', e.message);
  }

  // 6. Test Payments
  console.log('\n--- 6. Testing GET /api/v1/payments ---');
  try {
    const res = await fetchJson(`${BASE_URL}api/v1/payments?page=1&limit=5`, { headers: authHeaders });
    console.log(`Status: ${res.status}`);
    if (res.status === 200 && res.body?.success) {
      const data = res.body.data;
      const items = Array.isArray(data) ? data : (data?.data || data?.items || data?.results || []);
      console.log(`✅ Payments SUCCESS — got ${items.length} items`);
      if (items.length > 0) console.log('   Sample keys:', Object.keys(items[0]).join(', '));
      const total = data?.total || data?.count || res.body?.total;
      if (total) console.log(`   Total: ${total}`);
    } else {
      console.log('❌ Payments FAILED:', JSON.stringify(res.body).substring(0, 200));
    }
  } catch (e) {
    console.log('❌ Payments ERROR:', e.message);
  }

  console.log('\n=== Test Complete ===');
}

main().catch(console.error);

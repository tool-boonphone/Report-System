import axios from 'axios';

const baseUrl = process.env.BOONPHONE_API_URL || 'https://boonphone.demosiam.com/';
const username = process.env.BOONPHONE_API_USERNAME;
const password = process.env.BOONPHONE_API_PASSWORD;

try {
  const loginRes = await axios.post(baseUrl + 'api/v1/auth/login', { username, password });
  const token = loginRes.data?.data?.access_token;
  console.log('Boonphone login success:', !!token);
  
  const payRes = await axios.get(baseUrl + 'api/v1/payment', {
    params: { action: 'transactions', page: 1, per_page: 2 },
    headers: { Authorization: 'Bearer ' + token }
  });
  
  console.log('Response top-level keys:', Object.keys(payRes.data || {}));
  const data = payRes.data?.data;
  console.log('data keys:', Object.keys(data || {}));
  const items = data?.transactions || (Array.isArray(data) ? data : []);
  console.log('Items count:', items.length);
  if (items.length > 0) {
    console.log('First item keys:', Object.keys(items[0]));
    console.log('Has contract_code:', 'contract_code' in items[0]);
    console.log('Has contract_no:', 'contract_no' in items[0]);
    console.log('Has payment_status:', 'payment_status' in items[0]);
    console.log('Has status:', 'status' in items[0]);
    console.log('First item:', JSON.stringify(items[0]).substring(0, 500));
  }
} catch(e) {
  console.error('Error:', e.message, e.response?.status, JSON.stringify(e.response?.data || {}).substring(0, 200));
}

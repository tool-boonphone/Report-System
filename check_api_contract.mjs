import mysql from 'mysql2/promise';

const apiUrl = process.env.BOONPHONE_API_URL?.endsWith('/') 
  ? process.env.BOONPHONE_API_URL 
  : process.env.BOONPHONE_API_URL + '/';
const username = process.env.BOONPHONE_API_USERNAME;
const password = process.env.BOONPHONE_API_PASSWORD;

console.log('API URL:', apiUrl);

// Step 1: Get external_id from DB
const conn = await mysql.createConnection(process.env.DATABASE_URL);
const [dbRows] = await conn.execute(
  'SELECT external_id FROM contracts WHERE contract_no = ? LIMIT 1',
  ['CT0226-SRI005-1183-01']
);
await conn.end();
const externalId = dbRows[0]?.external_id;
console.log('External ID from DB:', externalId);

// Step 2: Login
const loginResp = await fetch(apiUrl + 'api/v1/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username, password })
});
const loginData = await loginResp.json();
const token = loginData.data?.access_token;
console.log('Login status:', loginResp.status, '| Token:', !!token);

if (!token) {
  console.log('Login response:', JSON.stringify(loginData).substring(0, 300));
  process.exit(1);
}

// Step 3: Get installments using action=installments with external_id
const instResp = await fetch(
  apiUrl + 'api/v1/contract?action=installments&id=' + externalId + '&limit=20&page=1', 
  { headers: { 'Authorization': 'Bearer ' + token } }
);
const instText = await instResp.text();
console.log('Installments status:', instResp.status);

let instData;
try { instData = JSON.parse(instText); } catch(e) { 
  console.log('Not JSON, first 300:', instText.substring(0, 300)); 
  process.exit(1); 
}

const insts = instData.data?.installments || instData.data?.data || instData.data || [];
const instArr = Array.isArray(insts) ? insts : [insts];
console.log('Total installments from API:', instArr.length);
console.log('Data keys:', Object.keys(instData.data || instData));

instArr.slice(0, 6).forEach((inst) => {
  const due = inst.due_date || inst.dueDate;
  const period = inst.period || inst.installment_no || inst.seq;
  const total = inst.total_due_amount || inst.amount;
  console.log(`  Period ${period}: due_date=${due}, total=${total}`);
});

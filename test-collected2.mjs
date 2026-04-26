import http from 'http';
const SESSION_ID = '26DNkGVq9nC_XRuJvqCP1IBUeTbh70UtQh1XgTdZfiJFvMpj';
const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/api/debt/stream/collected?section=Fastfone365',
  method: 'GET',
  headers: { 'Cookie': `report_session=${SESSION_ID}` }
};
const data = await new Promise((resolve, reject) => {
  const req = http.request(options, (res) => {
    let buf = '';
    res.on('data', (chunk) => { buf += chunk; });
    res.on('end', () => resolve(buf));
  });
  req.on('error', reject);
  req.end();
});
const obj = JSON.parse(data);
const rows = obj.rows || [];
const found = rows.find(r => r.contractNo === 'CT0925-PKN001-15462-01');
if (found) {
  console.log('Contract keys:', Object.keys(found));
  const payments = found.payments || found.installments || found.rows || [];
  console.log('\nPayments count:', payments.length);
  if (payments.length > 0) {
    console.log('Payment[0] keys:', Object.keys(payments[0]));
    console.log('Payment[0]:', JSON.stringify(payments[0], null, 2));
    console.log('\nAll payments:');
    payments.forEach(p => {
      console.log(JSON.stringify(p));
    });
  }
} else {
  console.log('Not found. Keys of row[0]:', Object.keys(rows[0] || {}));
}

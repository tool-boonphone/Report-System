import http from 'http';

const SESSION_ID = '26DNkGVq9nC_XRuJvqCP1IBUeTbh70UtQh1XgTdZfiJFvMpj';

const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/api/debt/stream/target?section=Fastfone365',
  method: 'GET',
  headers: { 'Cookie': `report_session=${SESSION_ID}` }
};

const data = await new Promise((resolve, reject) => {
  const req = http.request(options, (res) => {
    console.log('Status:', res.statusCode);
    let buf = '';
    res.on('data', (chunk) => { buf += chunk; });
    res.on('end', () => resolve(buf));
  });
  req.on('error', reject);
  req.end();
});

console.log('Data length:', data.length);

try {
  const obj = JSON.parse(data);
  const rows = obj.rows || [];
  console.log('Total rows:', rows.length);
  
  const found = rows.find(r => r.contractNo === 'CT0925-PKN001-15462-01');
  if (found) {
    console.log('\nFound contract! installments:');
    (found.installments || []).forEach(inst => {
      console.log(`  period ${inst.period}: amount=${inst.amount}, isClosed=${inst.isClosed}, overpaidCarryLabel=${inst.overpaidCarryLabel}, overpaidApplied=${inst.overpaidApplied}`);
    });
  } else {
    console.log('Contract not found');
    // Show first few contracts
    console.log('First 3 contracts:', rows.slice(0, 3).map(r => r.contractNo));
  }
} catch(e) {
  console.log('Parse error:', e.message);
  console.log('First 500:', data.substring(0, 500));
}

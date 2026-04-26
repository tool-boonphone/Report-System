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
  console.log('Found contract! Full installments:');
  (found.installments || []).forEach(inst => {
    console.log(`  period ${inst.period}: amount=${inst.amount}, paid=${inst.paid}, isClosed=${inst.isClosed}, overpaidCarryLabel=${inst.overpaidCarryLabel}, overpaidApplied=${inst.overpaidApplied}, principal=${inst.principal}, interest=${inst.interest}, fee=${inst.fee}`);
  });
} else {
  console.log('Contract not found');
}

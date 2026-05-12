import mysql from 'mysql2/promise';

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// bad_debt ใน cache per contract
const [cachePerContract] = await conn.execute(`
  SELECT 
    contract_external_id,
    SUM(bad_debt) as cache_bad_debt
  FROM debt_collected_cache
  WHERE section = 'Fastfone365' AND bad_debt > 0
  GROUP BY contract_external_id
`);

const section = 'Fastfone365';
const bdlSubquery = `
  SELECT
    inner_q.contract_no, inner_q.section,
    inner_q.last_paid_date, inner_q.last_created_at, inner_q.last_updated_by
  FROM (
    SELECT
      pt2.contract_no, pt2.section,
      DATE(pt2.paid_at) AS last_paid_date,
      pt2.created_at AS last_created_at,
      pt2.updated_by AS last_updated_by,
      ROW_NUMBER() OVER (
        PARTITION BY pt2.contract_no, pt2.section
        ORDER BY pt2.paid_at DESC, pt2.created_at DESC
      ) AS rn
    FROM payment_transactions pt2
    WHERE pt2.section = '${section}'
      AND JSON_EXTRACT(pt2.raw_json, '$.source') IS NULL
  ) AS inner_q
  WHERE inner_q.rn = 1
`;

const [incomePerContract] = await conn.execute(`
  SELECT 
    c.external_id as contract_external_id,
    c.contract_no,
    SUM(CASE
      WHEN c.status = 'หนี้เสีย'
        AND bdl.last_paid_date IS NOT NULL
        AND DATE(pt.paid_at) = bdl.last_paid_date
        AND bdl.last_created_at IS NOT NULL
        AND DATE(pt.created_at) = DATE(bdl.last_created_at)
        AND (bdl.last_updated_by IS NULL OR pt.updated_by = bdl.last_updated_by)
      THEN pt.amount ELSE 0 END) AS income_bad_debt
  FROM payment_transactions pt
  LEFT JOIN contracts c ON c.contract_no = pt.contract_no AND c.section = pt.section
  LEFT JOIN (${bdlSubquery}) AS bdl ON bdl.contract_no = pt.contract_no AND bdl.section = pt.section
  WHERE pt.section = '${section}'
    AND JSON_EXTRACT(pt.raw_json, '$.source') IS NULL
  GROUP BY c.external_id, c.contract_no
  HAVING income_bad_debt > 0
`);

// สร้าง map
const cacheMap = new Map(cachePerContract.map(r => [String(r.contract_external_id), parseFloat(r.cache_bad_debt)]));
const incomeMap = new Map(incomePerContract.map(r => [String(r.contract_external_id), { val: parseFloat(r.income_bad_debt), contractNo: r.contract_no }]));

// หา contracts ที่มีความต่าง
const diffs = [];
for (const [id, cacheVal] of cacheMap) {
  const incomeEntry = incomeMap.get(id);
  const incomeVal = incomeEntry ? incomeEntry.val : 0;
  const diff = cacheVal - incomeVal;
  if (Math.abs(diff) > 0.01) {
    diffs.push({ contract_external_id: id, contractNo: incomeEntry?.contractNo ?? '?', cache: cacheVal, income: incomeVal, diff });
  }
}
// contracts ที่อยู่ใน income แต่ไม่อยู่ใน cache
for (const [id, entry] of incomeMap) {
  if (!cacheMap.has(id)) {
    diffs.push({ contract_external_id: id, contractNo: entry.contractNo, cache: 0, income: entry.val, diff: -entry.val });
  }
}

diffs.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
console.log('Contracts with diff (top 20):');
diffs.slice(0, 20).forEach(d => console.log(JSON.stringify(d)));
console.log('Total diff contracts:', diffs.length);
console.log('Sum of diffs:', diffs.reduce((s, d) => s + d.diff, 0).toFixed(2));

await conn.end();

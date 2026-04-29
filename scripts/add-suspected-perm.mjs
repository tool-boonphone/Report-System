import mysql from 'mysql2/promise';

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// Get all groups that have bad_debt_summary permission
const [existing] = await conn.execute(
  "SELECT group_id, can_view, can_add, can_edit, can_delete, can_approve, can_export FROM app_group_permissions WHERE menu_code = 'bad_debt_summary'"
);

// Check which already have suspected_bad_debt
const [alreadyHave] = await conn.execute(
  "SELECT group_id FROM app_group_permissions WHERE menu_code = 'suspected_bad_debt'"
);
const alreadySet = new Set(alreadyHave.map(x => x.group_id));

let inserted = 0;
for (const g of existing) {
  if (!alreadySet.has(g.group_id)) {
    await conn.execute(
      "INSERT INTO app_group_permissions (group_id, menu_code, can_view, can_add, can_edit, can_delete, can_approve, can_export) VALUES (?, 'suspected_bad_debt', ?, ?, ?, ?, ?, ?)",
      [g.group_id, g.can_view, g.can_add, g.can_edit, g.can_delete, g.can_approve, g.can_export]
    );
    inserted++;
  }
}
console.log('Inserted', inserted, 'permissions for suspected_bad_debt');
await conn.end();

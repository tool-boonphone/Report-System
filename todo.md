# Report System - Project TODO

ระบบ Report System สำหรับ Boonphone และ Fastfone365 พัฒนาด้วย React 19 + TypeScript + tRPC + Drizzle ORM

---

## Phase 1 — Foundation (Design System & Database Schema)

- [x] วางโครงสร้างโปรเจคและ Design System (สี, Typography, Layout, Mobile-First) อ้างอิง ZORT UI
- [x] ออกแบบ Database Schema (Drizzle)
  - [x] `app_users` — ผู้ใช้งานภายในระบบ (username, password hash, status)
  - [x] `app_groups` — กลุ่มสิทธิ์ (Super Admin, ...)
  - [x] `app_group_permissions` — สิทธิ์แต่ละเมนู (view/add/delete/edit/approve/export)
  - [x] `app_sessions` — Session Token
  - [x] `sync_logs` — Log การ Sync ข้อมูล
  - [x] `bp_contracts`, `bp_installments`, `bp_payments`, `bp_partners`, `bp_customers` — Database Boonphone
  - [x] `ff_contracts`, `ff_installments`, `ff_payments`, `ff_partners`, `ff_customers` — Database Fastfone365
- [x] สร้าง Default Super Admin User (Sadmin / Aa123456+)
- [x] สร้าง Default Super Admin Group

## Phase 2 — Authentication & User Management

- [x] หน้า Login (custom username/password — ไม่ใช้ Manus OAuth)
- [x] หน้าเลือก Section (Boonphone / Fastfone365)
- [x] Fixed Header (Logo + Section Switcher + Menu + User icon) — ปุ่ม Refresh/Export จะถูกฉีดจากแต่ละหน้าผ่าน NavActionsContext ใน Phase 4/5
- [x] Responsive Mobile-First Layout (Hamburger menu บนมือถือ)
- [x] เมนูตั้งค่า: จัดการผู้ใช้งาน (CRUD + เปลี่ยนรหัสผ่าน + เปิด/ปิด)
- [x] เมนูตั้งค่า: จัดการสิทธิ์ (Group CRUD + Permission matrix)
- [x] ฟังก์ชันเปลี่ยนรหัสผ่านของตัวเอง
- [x] Logout

## Phase 3 — API Sync Engine

- [x] Backend client สำหรับ Boonphone API (login, contract, installments, payment, partner, customer)
- [~] Backend client สำหรับ Fastfone365 API — client พร้อมแล้ว รอ credentials ที่ถูกต้อง
- [x] Sync Engine พร้อม `_isSyncing` lock
- [x] Cron Job sync ทุก 1 ชั่วโมง (08:00–19:00 Mon–Sat)
- [x] Manual Sync (Background) + toast แจ้งเตือนเมื่อเสร็จ
- [x] แสดง "ข้อมูล ณ วันที่/เวลา" ใน Header + Relative time badge

## Phase 4 — Contract Report (ข้อมูลสัญญา)

- [x] ตาราง 41 คอลัมน์ตามไฟล์ Ex-Super_Report
- [x] Sticky Header (Table) + horizontal scroll บนมือถือ
- [x] Pagination (Offset/Limit) 50/หน้า
- [x] Search (เลขที่สัญญา + ชื่อลูกค้า + พาร์ทเนอร์ + โทร/IMEI/Serial/บัตร ปช.)
- [x] Filter (สถานะ, ประเภทหนี้, รหัสพาร์ทเนอร์, ช่วงวันที่)
- [x] Export Excel ตามสิทธิ์ (stream ด้วย ExcelJS)
- [x] Permission-guarded actions (contract.view / contract.export)

## Phase 5 — Debt Report (รายงานหนี้)

- [x] แสดง เป้าเก็บหนี้ (จาก installments ที่ครบกำหนดชำระ) ตามช่วงวันที่
- [x] แสดง ยอดเก็บหนี้ (จาก payment_transactions ที่ status = paid)
- [x] Summary Cards + รายเดือน + Top Overdue list
- [x] Export Excel (แยกจากข้อมูลสัญญา)
- [x] Permission-guarded actions (debt_report.view / debt_report.export)

## Phase 6 — Delivery

- [x] ตรวจสอบ Vitest tests + type check (20 passed, 1 skipped = Fastfone365 creds)
- [x] เชื่อมต่อ GitHub Repository และ Push โค้ด (remote `github` → `tool-boonphone/Report-System`, branch `main`)
- [x] สรุปโครงสร้าง + สร้าง README สำหรับ Handover (`README.md`)
- [x] Checkpoint + Deliver

---

## Conventions

- **GitHub**: commit ทุกครั้งที่จบฟีเจอร์ ด้วยข้อความภาษาอังกฤษชัดเจน (เช่น `Add: User Management`)
- **Naming**: camelCase สำหรับ TypeScript, snake_case สำหรับ DB columns
- **Env**: ทุก Config (API credentials, JWT secret) ต้องอยู่ใน env ไม่ hardcode
- **Mobile-First**: ทุกหน้าออกแบบให้ใช้งานบนมือถือได้ก่อน แล้วค่อยขยายสู่ desktop

---

## Blocked by user input (not agent TODOs)

รายการด้านล่างรอข้อมูลจากผู้ใช้ ไม่ใช่งานของ Agent:

- Fastfone365 API credentials — รอผู้ใช้อัปเดต ขณะนี้ 401 Unauthorized (ข้าม test ด้วย `SKIP_FASTFONE_CREDS`)
- เมื่อได้ credentials ใหม่ ให้เปิด test `Fastfone365 login returns a token` กลับมา และรัน sync เต็ม

---

## Phase 7 — UX polish (จาก feedback ผู้ใช้)

- [x] แสดง Login error เป็น inline banner ใต้ฟอร์ม (ไม่ใช้ toast ลอย + ไม่ให้หลุดไปโผล่ที่หน้าอื่น เช่น /contracts)
- [x] เคลียร์ช่องรหัสผ่าน + focus กลับเมื่อกรอกผิด เพื่อให้กดลองใหม่สะดวก
- [x] ไม่ให้ global mutation logger ยิง `console.error("[API Mutation Error]"…)` เมื่อ error เป็น UX ปกติ (login กรอกผิด, รหัสผ่านเดิมผิด, บัญชีถูกปิด) — ใช้ `EXPECTED_MUTATION_ERRORS` allowlist. ไม่มี global toast/redirect อื่นที่เกี่ยวข้อง error เหล่านี้

## Phase 8 — Bug fixes

- [x] หน้าข้อมูลสัญญา: คอลัมน์ข้อมูลลูกค้าว่าง
  - แก้ 2 จุด: (1) เชื่อม `mapCustomerProfile` เข้า `syncContracts` เพื่อ merge ข้อมูลลูกค้าจาก `customer?action=all`, (2) แก้ `server/sync/dbUpsert.ts` ให้ใช้ `VALUES(col)` ใน ON DUPLICATE KEY UPDATE (เดิม drizzle compile เป็น self-assign ที่ no-op → ทำให้ทุก sync ที่ผ่านมาไม่เคย update แถวเดิม)
  - เพิ่ม regression test `server/sync/dbUpsert.test.ts` กันไม่ให้ pattern self-assign กลับมา
  - รัน full sync Boonphone ใหม่ → 3,558/3,558 แถวมีชื่อ+เลขบัตร+โทร+อายุ+เงินเดือน+จังหวัดครบ (อาชีพ 3,405/บริษัท 3,428/อำเภอที่ทำงาน 3,538 แถว — ที่ขาด = ต้นทาง API ไม่เก็บ)
- [x] หน้าข้อมูลสัญญา: คอลัมน์ IMEI และ Serial No (เสร็จแบบมีข้อจำกัดต้นทาง)
  - เพิ่มขั้นตอน `enrichContractsWithDeviceIds()` ต่อท้าย `syncContracts` — ยิง `contract?action=detail&id=X` ด้วย concurrency 5 เฉพาะแถวที่ imei ยังว่าง
  - เพิ่ม unit test `server/sync/enrichDeviceIds.test.ts` ตรึง 3 เคส: (1) map imei+serial ถูก, (2) iPad Wi-Fi (imei ขาดจาก payload) → imei=null, serial ยังเข้า, (3) defensive กับ payload ว่าง
  - Backfill รอบแรก: Serial 3,558/3,558 (100%), IMEI 3,159/3,558 (88.8%)
  - **ข้อจำกัดต้นทาง**: แถว 399 ที่ยังไม่มี IMEI ทั้งหมดเป็น iPad Wi-Fi (อุปกรณ์ไม่มี GSM modem) ตามสเป็ก hardware—สุ่มตรวจแล้วยืนยันจาก `contract?action=detail` เองว่า field `contract.product.imei` ถูกส่งมาเป็น null
  - Sync ชุดถัดไปจะดึง detail เฉพาะรายใหม่ที่ยังไม่มี imei → ไม่โหลด API ซ้ำทุกรอบ
- [x] ประเมินความเป็นไปได้ของการถอด pagination (ผล benchmark: 3,559 แถว, payload 3.9 MB หลังตัด rawJson, DB cold 2.8s/warm 0.6s → เลือก virtual scroll)
- [x] เปลี่ยนหน้า /contracts จาก pagination เป็น virtual scroll
  - เพิ่ม `contracts.listAll` procedure ที่ตัด `rawJson` ออก (ประหยัด payload จาก 6.3 MB → 3.9 MB)
  - เปลี่ยนหน้า /contracts มาใช้ `@tanstack/react-virtual` (render เฉพาะแถวที่เห็นในจอ ~30 แถว)
  - search / filter / sort ทำฝั่ง client → ไม่ต้อง round-trip ใหม่ตอนพิมพ์
  - เพิ่ม access test คุม permission ของ `listAll` (UNAUTHORIZED/FORBIDDEN/Super Admin ได้ array)
- [x] เพิ่มไอคอนตั้งค่าบน TopNav และย้าย จัดการผู้ใช้งาน + จัดการสิทธิ์ ไปเป็น sub-menu
  - แยก `NAV_ITEMS` เป็น `MAIN_NAV` (ข้อมูลสัญญา / รายงานหนี้) และ `SETTINGS_NAV` (จัดการผู้ใช้งาน / จัดการสิทธิ์)
  - ไอคอน Settings วางหลังปุ่มที่แต่ละหน้า inject (เช่น Refresh/Export จาก /contracts)
  - คลิกไอคอนจะเปิด dropdown 2 เมนูย่อย — ซ่อนอัตโนมัติเมื่อเปลี่ยนหน้า และคลิกนอกเพื่อปิด
  - บนมือถือเมนู hamburger ยังแสดงเมนูทั้งสองแต่กลุ่มใต้หัวข้อ “ตั้งค่า”
  - Permission gating ยังทำงานเหมือนเดิม — ถ้าผู้ใช้ไม่มีสิทธิ์ใดแม้แต่เมนูเดียว ไอคอน/กลุ่มหัวข้อจะถูกซ่อนอัตโนมัติ
- [x] รื้อหน้ารายงานหนี้ใหม่ตาม reference boonphone.co.th/mm.html
  - เพิ่ม procedure `debt.listTarget` / `debt.listCollected` + helper ใน `server/debtDb.ts` — ดึง installments / payment_transactions จาก DB ปัจจุบัน 3,559 สัญญา/side ภายใน ~2–4 วินาที
  - แยกเงินต้น/ดอกเบี้ย/ค่าดำเนินการ ต่องวด จาก `raw_json` ด้วย `JSON_EXTRACT`
  - คำนวณ `debtStatus` และ `daysOverdue` ต่อสัญญา (ไล่เก็ตจากงวดที่ยังค้าง+เกินกำหนดมากที่สุด ୻ บักเก็ตเป็น ปกติ / 1-7 / 8-14 / 15-30 / 31-60 / 61-90 / >90 / ระงับสัญญา / สิ้นสุดสัญญา / หนี้เสีย)
  - เขียนหน้า `DebtReport.tsx` ใหม่: 2 tabs (เป้าเก็บหนี้ / ยอดเก็บหนี้), virtual scroll, sticky tier-1 header ระบุ “ข้อมูลชำระงวดที่ N”, แถบสึตารางสถานะพร้อมสี 10 แบบ, ค้นหา เลขสัญญา / ชื่อลูกค้า / เบอร์โทร + filter สถานะหนี้, ปุ่ม Export Excel
  - ข้อมูลจริงจาก DB — ตัวอย่างสัญญา CT0426-RBR002-4092-01 “โสภิตา แอวงษ์” 12 งวด เงินต้น 1,360 / ดอก 1,768 / ค่าดำเนินการ 100
  - เพิ่ม access test — ทั้ง UNAUTHORIZED / FORBIDDEN คลุมทั้งสอง procedure ใหม่

### Phase 9 — Debt Report (Collected Tab) Refinement
- [x] ปรับปรุงแถบ "ยอดเก็บหนี้" ให้มีคอลัมน์ครบตาม reference: งวดที่ / วันที่ชำระ / เงินต้น / ดอกเบี้ย / ค่าดำเนินการ / ค่าปรับ / ค่าปลดล็อก / ส่วนลด / ชำระเกิน / ปิดค่างวด / หนี้เสีย / ยอดที่ชำระรวม
  - **Backend**: แก้ `debtDb.ts` ให้ดึง field ใหม่จาก `raw_json` (เช่น `penalty_paid`, `unlock_fee_paid`, `discount_amount`, `overpaid_amount`, `close_installment_amount`, `bad_debt_amount`)
  - **Backend**: ไม่ต้องคำนวณยอดชำระเกิน/ปิดยอด/หนี้เสียเอง เพราะ API Boonphone คำนวณและส่งมาให้ตรงๆ ใน payment record แล้ว (เช่น `overpaid_amount`, `close_installment_amount`)
  - **Backend**: จับคู่ payment กับงวด (period) โดยใช้ `receipt_no` suffix (เช่น `-1`, `-2`)
  - **Frontend**: แก้ `DebtReport.tsx` ให้รองรับการชำระหลายครั้งต่องวด (sub-row "- แบ่งชำระ -") โดยคำนวณ `rowLineCount` เพื่อขยายความสูงของแถว (virtual scroll) ให้พอดีกับจำนวน payment ที่มากที่สุดในงวดใดงวดหนึ่งของสัญญานั้น
  - **Export**: แก้ `exportExcel.ts` ให้รองรับ 12 คอลัมน์ใหม่ และแยกแถว Excel สำหรับ payment ที่แบ่งชำระ (แถวแรกมีข้อมูลสัญญา แถวถัดไปเขียน "- แบ่งชำระ -")- [x] (superseded by Phase 9e) ปรับ `debt.listTarget` ให้หักยอด overpaid งวดก่อนหน้า — พิสูจน์แล้วว่า API หักให้ใน `installments.amount` อยู่แล้ว (trust-API)
- [x] (superseded by Phase 9e) ปรับ `debt.listTarget` เมื่อปิดยอด — ใช้ `amount = 0` จาก API + flag `isClosed`
- [x] เพิ่ม unit tests สำหรับ allocation rule (overpaid/close) และ collected-tab multi-payment mapping (debt.target-shape, debt.export)
- [x] (superseded) ลอจิก overpaid allocation ใน `debt.listTarget` — ใช้ annotation แทนการคำนวณซ้ำ
- [x] (superseded) ลอจิกปิดค่างวด — flag `isClosed` + annotation "ปิดค่างวดแล้ว"
- [~] Logic หนี้เสีย: แสดงยอดขายซากที่งวดล่าสุด — DEFERRED: ยังไม่มีเคส `bad_debt_amount > 0` ใน DB (query ตรวจแล้ว) จะเปิดเมื่อมีข้อมูลจริงเพื่อยืนยันรูปแบบ
- [x] ปรับสีและรูปแบบตาราง (tabs น้ำเงิน/แดง, header งวดมีแบ็คกราวน์ดสี, badge สถานะ 10 สี, annotation overpaid/closed เน้นสีเขียว/ฟ้า)

### Phase 9e — Overpaid allocation: verify source-of-truth before computing
- [x] Query DB: หาสัญญาตัวอย่างที่มี `overpaid_amount > 0` แล้วเทียบ `installments.amount` ของงวดถัดไป vs งวดก่อนหน้า (และ vs `contracts.installment_amount`)
- [x] สรุปผล: 57/63 เคสลดลงแล้ว, 5 เคสไม่ลดแต่ตรวจละเอียดพบว่า overpaid ถูกใช้ในงวดเดียวกัน → สรุป API หักยอดชำระเกินให้เรียบร้อยใน `installments.amount` แล้ว 100%
- [x] ตัดสินใจกลยุทธ์: **B+C** = trust API + annotation + "ปิดค่างวดแล้ว"
- [x] เอา logic คำนวณ overpaid/close ออกจาก `listDebtTarget` (trust API, ใช้ `amount` ตรงๆ)
- [x] เพิ่ม `baselineAmount`, `overpaidApplied`, `isClosed` ในแต่ละงวดของ `listDebtTarget` response
- [x] อัปเดต UI: annotation "(-หักชำระเกิน: xxx)" เมื่อ amount < baseline, แสดง "0.00 / ปิดค่างวดแล้ว" เมื่อ amount=0 แต่ baseline>0
- [x] ปรับสีและรูปแบบตารางให้ตรง reference boonphone.co.th/mm.html (tabs, group header, status badge)
- [x] Unit tests ผ่าน (`server/debt.target-shape.test.ts`) + แก้ export naming bug (`perInstallment` → `installmentAmount`)
- [x] Commit + push + checkpoint (commit `b2a4daf`, checkpoint `b2a4dafb`)

### Phase 9f — UX polish (user feedback 2026-04-23)
- [x] Login: removed placeholder text from username field
- [x] DebtReport table: replaced `truncate` with `whitespace-nowrap`; widened contractNo to 195px and customerName to 210px
- [x] Backend: redefined `isClosed` via `close_installment_amount > 0` + receipt_no suffix; marks only periods > maxClosedPeriod; zeroes principal/interest/fee/amount for closed periods
- [x] UI amount cell: shows literal "ปิดค่างวดแล้ว" text; italic gray color; light-gray background on all 4 money cells of closed periods
- [x] Added boundary-rule test in `server/debt.target-shape.test.ts` (closed cells form a contiguous suffix + all money fields zero)
- [x] Commit + push + save checkpoint (commit `e3e346f`, checkpoint `e3e346f9`)

### Phase 9g — เป้าเก็บหนี้: always show baseline for past/current periods (user rule 2026-04-23)

ผู้ใช้ยืนยันเงื่อนไขใหม่:
- งวดที่ผ่านมาแล้ว/งวดปัจจุบัน → `ยอดหนี้รวม` = ยอดเต็มจริง (baseline) **ไม่ใช่ amount จาก API** — แม้จะจ่ายครบแล้วก็ตาม เพื่อให้ฝ่ายเก็บหนี้เห็นยอดตั้งต้นของเดือน
- ยกเว้นมี overpaid จากงวดก่อน → ยอดหักได้ตามลำดับ
- "ปิดค่างวด" = จ่ายยอด**ทุกงวดที่เหลือ**ในคราวเดียว → งวดที่จ่ายปิดแสดงยอดปกติ, งวด**ถัดไปจนถึงงวดสุดท้าย**แสดง "ปิดค่างวดแล้ว" + 0

Task list:
- [x] Audit: ยืนยันว่าเคสที่ API ส่ง `amount=0` แบ่งออกเป็น (a) paid-in-full งวดเดียว (ควรแสดง baseline) กับ (b) post-close (ควรแสดง "ปิดค่างวดแล้ว") โดยดูจาก `close_installment_amount` + `receipt_no` suffix
- [x] Backend ใน `listDebtTarget` — actual implementation: **restore baseline** เมื่อ `amount=0 && paid>0 && !isClosed` (เคสที่ API zero ตอนจ่ายครบ); **trust API amount** เมื่อ API ลดยอดเองจาก overpaid carry; **zero out + isClosed=true** สำหรับงวด > maxClosedPeriod — ไม่ได้ implement manual compute-from-baseline carry-forward เพราะ API ทำให้แล้ว
- [x] Backend: เก็บ `overpaidApplied` สำหรับแสดง annotation `(-หักชำระเกิน: xxx)` ถ้ามี carry จากงวดก่อน
- [x] UI: งวด paid-in-full ที่ไม่ใช่ close → แสดงยอดเต็ม (ไม่มี "ปิดค่างวดแล้ว") — ไม่มี italic gray (ใช้ UI logic เดิมที่ render ตาม `isClosed` — backend fix ทำให้ isClosed=false สำหรับ paid-in-full → UI แสดงค่า amount เต็มโดยอัตโนมัติ)
- [x] UI: งวด post-close → literal "ปิดค่างวดแล้ว" + bg เทาอ่อน + text เทา italic (reused from Phase 9f — ไม่ได้แก้ UI รอบนี้เพราะทำเสร็จแล้ว)
- [x] Tests: ครอบ (a) paid-in-full no-close → ยอดเต็ม (baseline-restoration test ใหม่), (c) post-close → zero+closed (test เดิม). 
- [x] Test (b): เพิ่ม targeted test `listDebtTarget — overpaid carry surfaces correctly` ยืนยันว่า contract 1496/1517 มี amount < baseline และ overpaidApplied > 0 ในงวดถัดไป (ผ่านแล้ว)
- [x] Commit + push + save checkpoint (commit `f82caab`, checkpoint `f82caab9`)

### Phase 9h — Fix principal/interest split mismatch (contract 4092 reference)
- [x] Inspect installments.raw_json for contract ext that maps to CT0426-RBR002-4092-01 — พบว่า API ส่ง `principal_due=1360` / `interest_due=1768` ซึ่งเป็น base split (ก่อน rescale)
- [x] Update listDebtTarget mapping: เพิ่ม scaling formula `scale = (amount - fee - penalty) / (principal_due + interest_due)` แล้วคูณกลับเข้า principal/interest เพื่อให้ผลรวมเท่ากับ amount (เหมือน Boonphone admin UI)
- [x] Add regression test ใน `server/debt.target-shape.test.ts` — pin principal≈1907, interest≈2479, fee=100 สำหรับ CT0426-RBR002-4092-01 period 1 + invariant `principal+interest+fee+penalty ≈ amount` กับทุกงวด non-closed
- [x] Verify: รัน full test suite (37 passed / 1 skipped) → ทุก contract ที่มีข้อมูลผ่าน invariant
- [x] Commit + push + save checkpoint

### Phase 9i (DONE) — Fix incorrect overpaid annotation on partial payments
- [x] Investigate contract "สุทธิดา จงใจ" (paid 1000, installment 6985) showing "-หักชำระเกิน 750" on period 1 — พบว่า API ส่ง amount=6235 (ลดลง 750 จาก baseline 6985) แต่ไม่ได้เกิดจาก overpaid carry (overpaid_amount=0)
- [x] Fix `overpaidApplied` logic in `listDebtTarget` — เปลี่ยนจากใช้ `baseline - amount` มาเป็นการ sum `overpaid_amount` จาก payment ของงวดก่อนหน้า (P-1)
- [x] Add regression test for partial payment case — เพิ่มเคส false-positive ของ สุทธิดา จงใจ ใน `server/debt.target-shape.test.ts`
- [x] Commit + push + save checkpoint

### Phase 9j (DONE) — ระงับสัญญา / หนี้เสีย: exclude from collection targets (user rule 2026-04-23)

กฎใหม่ของผู้ใช้:
- **ระงับสัญญา**: หาเดือน (งวด) ที่สถานะเปลี่ยนเป็นระงับสัญญา → งวดถัดไปเป็นต้นไป `เงินต้น/ดอกเบี้ย/ค่าดำเนินการ = 0` และ `ยอดหนี้รวม = "ระงับสัญญา"` ใช้วันที่ที่ระงับเป็นวันที่แสดงในคอลัมน์วันที่
- **หนี้เสีย**: ไม่สนใจงวด — override ทับทุกงวดที่เคยเป็น "ระงับสัญญา" ให้เป็น "หนี้เสีย" ทั้งหมด + วันที่หนี้เสีย
- UI pattern เดียวกับ "สิ้นสุดสัญญา" (italic gray, light gray bg)
- เหตุผล: ยอดสองสถานะนี้ต้องไม่ถูกนับรวมเข้าเป้าเก็บหนี้

Task list:
- [x] Audit DB: พบว่า raw_json ไม่มี suspend_date/bad_debt_date แต่ installments.raw_json มี `installment_status_code` ต่องวด → ใช้ due_date ของ period แรกที่เป็น 'ระงับสัญญา' เป็น suspendedAt; DB ปัจจุบันมี 60 สัญญาระงับ, 0 สัญญาหนี้เสีย
- [x] Backend `listDebtTarget`: เพิ่ม `isSuspended`, `suspendLabel`, `suspendedAt` ต่อ cell; เซลล์ที่ suspended zero money fields ทั้งหมด; สัญญาสถานะ หนี้เสีย → label เป็น "หนี้เสีย" แทน
- [x] Frontend `DebtReport.tsx`: render label + suspendedAt ในคอลัมน์ amount/วันที่ (reuse closed-cell styling: bg gray-100 + italic gray-400)
- [x] Regression tests: เพิ่ม 3 เคส (suspended shape + non-suspended sanity + หนี้เสีย forward-compat); แก้ baseline-restoration invariant ให้ยกเว้น isSuspended; suite 41/41 ผ่าน
- [x] Commit + push + save checkpoint (commit 48cf0a0 → GitHub `tool-boonphone/Report-System`, checkpoint 48cf0a08)

### Phase 9k (NEW, TODO) — บันทึกยอดจำหน่ายเครื่องของสัญญาหนี้เสีย (feature ใหม่ นอกหน้าเป้าเก็บหนี้)

บริบทจาก user (2026-04-23):
- เมื่อเครื่องของสัญญาที่ "ระงับสัญญา" ถูกนำไปจำหน่าย จะมี "ยอดขายเครื่อง" บันทึกเข้ามาในสัญญานั้นช่วงที่ยังเป็นระงับสัญญา
- เมื่อบันทึกยอดนี้แล้ว สถานะจะถูกเปลี่ยนจาก "ระงับสัญญา" → "หนี้เสีย"
- ยอดนี้ใช้สำหรับคำนวณกำไร/ขาดทุนของสัญญาที่จบด้วยการขายเครื่อง

Task list:
- [ ] สำรวจใน DB/API ว่ามี field ไหนเก็บ "ยอดขายเครื่อง" สำหรับสัญญาหนี้เสีย (payment type พิเศษ? raw_json fields?)
- [ ] ออกแบบหน้า/แท็บใหม่: "สรุปกำไร/ขาดทุนจากหนี้เสีย" (ไม่ใช่ในหน้าเป้าเก็บหนี้)
- [ ] สูตรคำนวณกำไร/ขาดทุน: (ยอดที่เก็บได้ทั้งหมด รวมยอดขายเครื่อง) − (ต้นทุน/ยอดจัดไฟแนนซ์ที่เหลือ) = กำไร/ขาดทุน
- [ ] Export Excel และ UI แสดงยอดขายเครื่องเป็นคอลัมน์แยก

### Phase 9j-bis (DONE) — วันที่หนี้เสีย = วันที่ payment สุดท้ายระหว่างยังระงับ

Business rule เพิ่มเติมจาก user (2026-04-23):
- "วันที่รับยอดสุดท้ายตอนที่ยังเป็นระงับสัญญาอยู่นั่นแหละคือวันที่ถูกบันทึกว่าเป็นหนี้เสีย"
- = วันที่ payment ล่าสุดที่เกิดหลัง due_date ของงวดแรกที่ถูกมาร์ค 'ระงับสัญญา' จนถึงตอนที่สถานะเปลี่ยนเป็น 'หนี้เสีย'

Task list:
- [x] Backend: เพิ่ม pure helper `deriveBadDebtDate(payments, suspendedAt)` (ใช้ strict > เปรียบเทียบ ISO strings; fallback เป็น suspendedAt)
- [x] Backend `listDebtTarget`: เก็บ `paidAtsByContract` ตอนวนลูป payments (zero extra query), แล้วเรียก helper สำหรับสัญญา `หนี้เสีย` ทับ suspendedAt → ใช้ต่อทุก cell
- [x] Fixture-backed unit test — 7 เคส ใน `server/debt.badDebtDate.test.ts` (null suspendedAt, no payments, all-before, latest-after, mixed null, strict-equality, ISO datetime sort)
- [x] รัน suite 48/48 ผ่าน (1 skipped); commit + push + checkpoint

### Phase 9j-ter (CLOSED — Decision C) — ไม่ใช้วันที่ระงับสัญญาจริงจาก API เพราะยังไม่มีใน endpoint ที่ document

บริบทจาก user (2026-04-23):
- ระบบ Boonphone มีแท็บ "การติดตามค่างวด" เก็บประวัติการติดตาม
- ตัวอย่าง ธัญธร มหาดไทย (CT0226-UTT002-1265-01): การติดตามครั้งที่ 4 (21 เม.ย. 2569) = "ต้องการระงับสัญญา"
- วันที่จริงของการระงับ = วันที่ของ follow-up entry ที่ตัวเลือก "ต้องการระงับสัญญา" ถูกกด
- ตอนนี้ระบบใช้ due_date ของงวดแรกที่เป็น "ระงับสัญญา" ซึ่งเป็นแค่ approximation

Task list:
- [x] ตรวจ Postman collection + DB schema — ไม่มี endpoint "การติดตามค่างวด" ใน collection; installments.raw_json มีแค่ฟิลด์ `suspended_at` / `bad_debt_at` แต่ค่าเป็น null ทั้งหมด (รวมถึง CT0226-UTT002-1265-01 ของธัญธร)
- [x] **Decision C**: ยอมรัป approximation — ใช้ due_date ของงวดแรกที่เป็น "ระงับสัญญา" เป็น suspendedAt ตามที่ระบบทำไว้แล้วใน Phase 9j
- [x] ไม่ต้องแก้โค้ด; ไม่ต้อง commit ใหม่
- [ ] **Deferred**: ตอนเริ่มงาน Fastfone365 ให้ตรวจซ้ำว่า API Fastfone ส่ง suspended_at/bad_debt_at จริงหรือไม่

### Phase 9L (TODO) — แก้ 5 ประเด็นในแท็บยอดเก็บหนี้ + สำรวจ pattern การปิดยอด

Reported by user (2026-04-23, ref มณีรัตน์ ช่วยบำรุง / สุวิทย์ เทศเขียว / เอกลักษณ์ ดวงกำ):

Issues:
1. "ปิดค่างวด" แสดงผิด: มณีรัตน์จ่าย 1,000 บาท แต่ระบบไปใส่ในช่อง "ปิดค่างวด" ทั้งที่กฎตกลงกันว่าปิดค่างวด = ปิดทั้งสัญญาเท่านั้น
2. คอลัมน์ "งวดที่" ของการชำระครั้งที่ 2, 3, ... ให้แสดงเป็น `N-M` (เช่น 2-1, 2-2) แทน "—"
3. ลบสีแดง/ตัวเอียงของยอดชำระครั้งที่ 2, 3, ... — ใช้ style เดียวกับครั้งแรก
4. คอลัมน์เงินต้น/ดอกเบี้ย/ค่าดำเนินการ/ฯลฯ ของงวดก่อนหน้า + งวดปัจจุบัน: ถ้าไม่มียอด ให้แสดง "0" สีเทาเอียง ไม่ปล่อยว่าง
5. คอลัมน์ "ส่วนลด" แสดงตัวเลขไม่ครบ (อาจถูกตัดความกว้างหรือ field ไม่ map)

Question:
- ทำไมการปิดยอดลงงวดไม่เหมือนกันระหว่างสัญญา:
  - สุวิทย์ เทศเขียว: บันทึกทุกงวดยกเว้นงวด 11
  - เอกลักษณ์ ดวงกำ: บันทึกที่งวด 12 ทีเดียว (งวด 2-11 ว่าง)

Task list:
- [x] สำรวจ DB: dump payments + installments ของทั้ง 3 สัญญา; หา receipt_no patterns + เปรียบเทียบกับ close-contract heuristic ปัจจุบัน (`TXRTC*`) — ยืนยันว่า `close_installment_amount` เป็น field ที่ API ส่งมากับ payment ปกติทุกครั้ง ไม่สามารถใช้ชี้ขาด close-contract ได้
- [x] Backend: ปรับเงื่อนไข isCloseRow ให้เช็ค `receipt_no.startsWith("TXRTC")` เท่านั้น (แยก assignPayPeriods ออกเป็น module-level export เพื่อให้ unit test ได้)
- [x] Backend: discount + penalty mapping ยังคงอ่านจาก raw_json ตรงๆ (discount_amount / penalty_paid) — field มีอยู่แล้ว, ปัญหาอยู่ที่ frontend ที่เคยเช็ค truthy แล้วว่างเปล่า
- [x] Frontend DebtReport.tsx: label `N-M` (period-splitIndex+1), ลบ `text-amber-700 italic` จาก sub-rows, แสดง `0` grey-italic เมื่อ pay ไม่มีค่า/เป็น 0, discount แสดงค่าเสมอ
- [x] Regression tests: 6 cases ใน `server/debt.collected-shape.test.ts` — pin มณีรัตน์ (no isCloseRow on partial 1000), TXRTC → isCloseRow=true, splitIndex progression, bad-debt routing
- [x] Full test suite: 54/55 passed (1 skipped = Fastfone365 creds)
- [x] Commit + push + save checkpoint

### Phase 9M (TODO) — TXRTC per-period display + pink highlight

Reported by user (2026-04-23 continuation of 9L):
- ต้องการให้ยอดปิดค่างวด/ปิดสัญญาแสดงครบทุกงวดที่เหลือ (ไม่ว่าจะงวดไหน) วันที่ใช้ paid_at จริง
- ส่วนลด (discount) ของ TXRTC อยู่ที่งวดสุดท้ายไล่ขึ้น (business rule)
- Highlight แถวที่เป็น TXRTC ด้วยสีพื้น rose-50 + border-l-4 rose-400

Task list:
- [x] Audit DB: สุวิทย์ 12 TXRTC (1 ใบ/งวด), เอกลักษณ์ 1 TXRT + 11 TXRTC (1 ใบ/งวดที่เหลือ), มณีรัตน์ partial 3 ใบ (ไม่มี TXRTC) — พบว่า principal/interest/fee เป็น null ใน TXRTC ทำให้ cursor-walk เดิมไม่เลื่อน
- [x] Fix `assignPayPeriods` — แยก cursor logic: TXRTC → advance +1 เสมอต่อ 1 ใบ (clamp ที่งวดสุดท้าย), regular TXRT → amount-based ด้วย fallback จาก pif ไป close_installment ไป total
- [x] Frontend DebtReport.tsx — ทุกเซลล์ของแถว isCloseRow มี bg `#fff1f2` (rose-50) + text-rose-700 + เส้นซ้าย 4px rose-400 ที่คอลัมน์แรกของ group
- [x] Regression tests: 4 เคสใหม่ (สุวิทย์ 12/12, เอกลักษณ์ 1+11=12, clamp-at-last, มณีรัตน์ partial) — รวม 58/59 tests ผ่าน
- [x] Commit + push + checkpoint (commit 71fbef8)

### Phase 9N (TODO) — Color theme + grey inactive periods

- [x] Tab เป้าเก็บหนี้: amber-600 (button, header bg amber-700, sub-header amber-50/100 alternating, text amber-900)
- [x] Tab ยอดเก็บหนี้: emerald-600 (button, header bg emerald-700, sub-header emerald-50, text emerald-900)
- [x] TXRTC highlight ยังคงเป็น rose-50/rose-400 (ไม่เปลี่ยน)
- [x] ยอดเก็บหนี้: isInactivePeriod logic (periodNo > instCount || (suspended && noPay)) → bg gray-100 + text-gray-400 italic, tooltip บอกเหตุผล
- [x] Commit + push + checkpoint

### Phase 9O (DONE) — Cumulative arrears + styling

- [x] Backend: เพิ่ม `unlock_fee_due` ใน InstRawRow + installments query (JSON_EXTRACT)
- [x] Backend: cumulative arrears pass — วน period 1..N, สะสม (due-paid) ข้ามงวด, reset เมื่อ TXRTC; flag `isArrears=true` เมื่อ carry > 0
- [x] Backend: `isArrears: boolean` + `unlockFee: number` อยู่ใน TargetRow แล้ว
- [x] Frontend เป้าเก็บหนี้: isArrears=true → bg-amber-100 + text-amber-800 + font-bold
- [x] Frontend ยอดเก็บหนี้: penalty=red-600, overpaid=emerald-700 font-bold, badDebt=red-700 font-bold, total=font-bold, 0.00 ใน TXRTC row=rose-300 italic
- [x] Regression tests: 61/62 pass (3 เคสใหม่: isArrears บนทุกเซลล์, unlockFee >= 0, isArrears=false เมื่อจ่ายครบ)
- [x] Commit + push + checkpoint (commit dc82bbb)

### Phase 9P (DONE) — Fix arrears carry: past/current periods only

- [x] Backend debtDb.ts: arrears carry pass สะสมเฉพาะงวดที่ `dueDate <= today` (past+current), งวดอนาคต carry=0 ไม่ทบ
- [x] Regression tests: 2 เคสใหม่ — future periods isArrears=false, partial-paid past period → next period isArrears=true — 63/64 pass
- [x] Commit + push + checkpoint (commit 9a84698)

### Phase 9T — แก้ principal/interest (กำจัดเศษทศนิยม)
- [x] แก้ debtDb.ts: เปลี่ยนจาก scale factor → ใช้สูตร principal=ceil(finance/periods), interest=baseline-principal-fee
- [x] ดึง finance_amount จาก contracts table มาใช้ใน query
- [x] Tests 63/64 pass + commit 24f520d + push + checkpoint

### Phase 9U — ค่าปรับ/ค่าปลดล็อก + Switch + ซ่อนปิดค่างวด
- [x] Frontend target tab: เพิ่มคอลัมน์ค่าปรับ + ค่าปลดล็อก ใน groupCols
- [x] Frontend target tab: เพิ่ม Switch "เฉพาะเงินต้น" ใต้ Select สถานะหนี้ (ขวาบนตาราง), default=เปิด (แสดง 0), ปิด=แสดงค่าจริง
- [x] Frontend target tab: ยอดหนี้รวม = amount (baseline) เมื่อ switch เปิด; = amount+penalty+unlockFee เมื่อ switch ปิด (ถ้ามี)
- [x] Frontend collected tab: ซ่อนคอลัมน์ "ปิดค่างวด" (closeInstallmentAmount) ออกจาก groupCols + cell renderer
- [x] Export target Excel: เพิ่ม penalty + unlockFee columns
- [x] Export collected Excel: ซ่อน closeInstallmentAmount column
- [x] Tests + commit + push + checkpoint

### Phase 9V — Switch เฉพาะเงินต้น: past periods คงค่าจริงเสมอ
- [x] Frontend target tab: Switch มีผลเฉพาะงวดปัจจุบัน+อนาคต (dueDate >= today); งวดที่ผ่านมาแล้วแสดงค่าจริงเสมอ (penalty/unlockFee/amount ไม่ถูก override)
- [x] TypeScript 0 errors + commit + push + checkpoint

### Phase 9W — แก้ arrears carry: fee/unlockFee ไม่สะสมข้ามงวด (merged into 9X)
- [x] debtDb.ts: ลบ carry pass ออกทั้งหมด ใช้ formula-based + API *_due แทน

### Phase 9X — Formula-based principal/interest + API penalty/unlockFee + arrears pass
- [x] debtDb.ts: principal/interest/fee คำนวณจากสูตร (ceil(finance/periods), baseline-principal-fee)
- [x] debtDb.ts: penalty/unlockFee ดึงจาก API penalty_due/unlock_fee_due โดยตรง
- [x] debtDb.ts: amount = API amount (source of truth); sub-fields ถูก scale ให้พอดกับ (amount - penalty - unlockFee)
- [x] debtDb.ts: overpaid deduction จากงวดก่อนหน้าหักตามสัดส่วน
- [x] debtDb.ts: isArrears = penalty_due > 0 || unlock_fee_due > 0 + partial-payment carry pass
- [x] Tests 63/64 pass + commit 1e8ddfa + push + checkpoint

### Phase 9Y — แก้ isArrears per-period
- [x] debtDb.ts: isArrears = per-period เฉพาะงวดที่มี penalty_due > 0 || unlock_fee_due > 0 จริงๆ และ dueDate <= today (past/current only)
- [x] TypeScript 0 errors + tests 63/64 pass + commit c815d75 + push + checkpoint

### Phase 9Z — isArrears งวดปัจจุบัน + penalty carry + isClosed display fix
- [x] debtDb.ts: isArrears = เฉพาะงวดปัจจุบัน (dueDate ใกล้ที่สุดที่ยังไม่จ่ายครบ) เท่านั้น
- [x] debtDb.ts: penalty ในงวดปัจจุบัน = รวมค่าปรับคงค้างทุกงวดที่ผ่านมา (sum of all penalty_due ที่ dueDate <= today)
- [x] DebtReport.tsx: isClosed display = สีเทา + ตัวเอียง + 0 ทุก column + "ปิดค่างวดแล้ว" ที่ยอดหนี้รวม (เหมือน isSuspended)
- [x] TypeScript 0 errors + tests 63/64 pass + commit 3f48248 + push + checkpoint

### Phase 9AA — แก้ 4 จุด: isArrears + Switch + penalty future + isClosed
- [ ] debtDb.ts: isArrears = มียอดค้างจากงวดก่อนเท่านั้น (ไม่ใช่ค่าปรับของงวดตัวเอง) — ต้องนิยาม "ค้างจากงวดก่อน" ให้ชัดเจน
- [ ] DebtReport.tsx: Switch เฉพาะเงินต้น=เปิด → penalty/unlockFee = 0 ทุกงวด (ไม่มีข้อยกเว้น)
- [ ] debtDb.ts/DebtReport.tsx: penalty/unlockFee แสดงเฉพาะงวดปัจจุบัน งวดอนาคต = 0
- [ ] DebtReport.tsx: สิ้นสุดสัญญา — งวดที่ผ่านมาแล้ว (dueDate < today) ต้องเป็นสีเทา 0 เหมือน isSuspended
- [ ] TypeScript 0 errors + tests + commit + push + checkpoint

### Phase 9AD — สูตรค่าดำเนินการ/เงินต้น/ดอกเบี้ย + ค่าปรับสะสม
- [x] debtDb.ts: ค่าดำเนินการ = 100 เสมอ (ไม่ scale ตาม ratio)
- [x] debtDb.ts: เงินต้น = ceil(finance/periods) คงที่ — overpaid carry หักจากเงินต้นก่อน ถ้าหมดแล้วค่อยหักดอกเบี้ย
- [x] debtDb.ts: ดอกเบี้ย = ยอดงวดจริง - เงินต้น - 100 (รับส่วนที่เหลือ)
- [x] debtDb.ts: ค่าปรับงวดปัจจุบัน = penalty_due ของงวดนี้ + ค่าปรับค้างสะสมจากงวดก่อนหน้าทั้งหมด
- [x] TypeScript 0 errors + tests + commit + push + checkpoint

### Phase 9AE — Highlight งวดปัจจุบันในตารางเป้าเก็บหนี้
- [x] DebtReport.tsx: งวดปัจจุบัน (isCurrentPeriod=true) ใช้ BG sky-50 (#f0f9ff) เพื่อให้เห็นชัดว่าตรงไหนคืองวดนี้
- [x] TypeScript 0 errors + tests 63/64 pass + commit + push + checkpoint

### Phase 9AF — แก้ยอดหนี้รวมตาม Switch เฉพาะเงินต้น
- [x] DebtReport.tsx: เปิด เฉพาะเงินต้น → ยอดหนี้รวม = principal+interest+fee (ไม่รวม penalty/unlockFee)
- [x] DebtReport.tsx: ปิด เฉพาะเงินต้น → ยอดหนี้รวม = principal+interest+fee+penalty+unlockFee (รวมค่าปรับ)
- [x] TypeScript 0 errors + tests 63/64 pass + commit + push + checkpoint

### Phase 9AG — Style ยอดเก็บหนี้: ค่าปลดล็อก/ส่วนลด/หนี้เสีย
- [x] DebtReport.tsx (collected tab): ค่าปลดล็อก (unlockFee > 0) → สีส้ม (text-orange-600) ตัวหนา
- [x] DebtReport.tsx (collected tab): ส่วนลด (discount > 0) → สีเขียวอมฟ้า (text-teal-600) ไม่เอียง
- [x] DebtReport.tsx (collected tab): หนี้เสีย (badDebt > 0) → สีแดง (text-red-700) ตัวหนา
- [x] TypeScript 0 errors + commit + push + checkpoint

### Phase 9AH — แก้ยอดหนี้รวมงวดที่มีค่าปรับค้างจากงวดก่อน
- [x] ตรวจสอบว่า inst.amount ของงวดที่ไม่ใช่ currentPeriod รวม penalty/unlockFee ไว้หรือไม่
- [x] เพิ่ม netAmount (principal+interest+fee) ใน backend และ frontend ใช้ netAmount แทนการหัก penalty จาก amount
- [x] TypeScript 0 errors + commit + push + checkpoint

### Phase 9AI — Style งวดอนาคต + ค่าปลดล็อก
- [x] DebtReport.tsx: งวดที่ยังไม่ถึงกำหนด (future period) → ตัวหนังสือสีเทา (gray-400)
- [x] DebtReport.tsx: ค่าปลดล็อก (unlockFee > 0) → text-blue-500 ไม่ตัวหนา
- [x] TypeScript 0 errors + commit 608026c + push + checkpoint

### Phase 9AJ — แก้ยอดหนี้รวม principalOnly=OFF
- [x] DebtReport.tsx: principalOnly=OFF → ยอดหนี้รวม = netAmount + penalty + unlockFee
- [x] TypeScript 0 errors + commit d56c42d + push + checkpoint

### Phase 9AK — แก้ระงับสัญญา row styling
- [x] debtDb.ts: Phase 9AK fallback — contract.status=ระงับสัญญา แต่ไม่มี installment ที่ status_code=ระงับสัญญา → treat ทุก period เป็น suspended จาก period 1
- [x] TypeScript 0 errors + commit 2db4443 + push + checkpoint

### Phase 10 — UI/UX Improvements (9 items)
- [x] P10-1: เพิ่มสิทธิ์ "การสลับ Section" ไว้บนสุดของรายการสิทธิ์ใน UserManagement
- [x] P10-2: Section switcher icon ที่มุมซ้ายบน — คลิกแล้วเห็น icon อีก Section เลือกได้เลย ไม่ต้องออกมาหน้าเลือก Section
- [x] P10-3: ย้ายปุ่ม เป้าเก็บหนี้/ยอดเก็บหนี้ มาซ้าย แทนหัวข้อ รายงานหนี้ แล้วเอาหัวข้อออก
- [x] P10-4: ไอคอน sticky column toggle ที่หัวตาราง (วันที่อนุมัติ/เลขที่สัญญา/ชื่อ/เบอร์/ยอดผ่อนรวม/งวดผ่อน/ผ่อนงวดละ/สถานะหนี้/เกินกำหนด)
- [x] P10-5: Multi-select status filter ในทั้ง 2 tab (เป้าเก็บหนี้ + ยอดเก็บหนี้)
- [x] P10-6: ย้ายปุ่ม Export ในหน้าข้อมูลสัญญา มาขวาสุดแนวเดียวกับค้นหา เปลี่ยนชื่อเป็น Export Excel สีเขียว
- [x] P10-7: ย้ายปุ่ม Export ในหน้ารายงานหนี้ มาขวาสุดแนวเดียวกับปุ่ม tab เปลี่ยนชื่อเป็น Export Excel สีเขียว
- [x] P10-8: Collapsible filter panel ในหน้าข้อมูลสัญญา (หุบ/ขยาย) ตัวกรองสัมพันธ์กันทุกคอลัมน์
- [x] P10-9: ยกเลิกการจำกัดความกว้างตาราง ให้ปล่อยตามขนาดหน้าจอ

### Phase 11 — UX Improvements (3 items)
- [x] P11-1: ตัวกรองข้อมูลสัญญา cascading interdependent — ตัวเลือกแต่ละตัวกรองตัดออกตามตัวกรองอื่น (สัมพันธ์กันทุกคอลัมน์)
- [x] P11-2: การจัดการสิทธิ์ section — กลุ่มสิทธิ์สามารถกำหนดได้ว่าเข้าถึง Section ไหนได้บ้าง
- [x] P11-3: Contextual row highlight (hover) ทุกตาราง — ผู้ใช้รู้ว่ากำลังจัดการแถวไหน

### Phase 12 — Bug Fix: Installment Date Ordering
- [ ] P12-1: ตรวจสอบ root cause ของ bug วันที่ต้องชำระงวดที่ 1 อยู่หลังงวดที่ 2 (CT0226-SRI005-1183-01: งวด1=2027-01-05, งวด2=2026-04-05)
- [ ] P12-2: แก้ไข debtDb.ts ให้เรียงลำดับ installments ตาม due_date ก่อนใช้งาน
- [ ] P12-3: ตรวจสอบว่ามีสัญญาอื่นที่มีปัญหาเดียวกันหรือไม่

### Phase 13 — DebtReport UX Improvements (5 items)
- [x] P13-1: แก้ไข Contextual Highlight ให้ชัดเจนบนทุก row type (งวดปัจจุบัน/ปิดค่างวด/สีแดง/สีเทา) โดยใช้ outline/ring แทน bg เพื่อไม่ให้กลืนกับสีพื้นหลังของ row
- [x] P13-2: เพิ่มฟิลเตอร์ "เดือน-ปีที่อนุมัติสัญญา" และ "เดือน-ปีที่ต้องชำระ" แบบ Multiple choice ใน tab เป้าเก็บหนี้
- [x] P13-3: เพิ่ม Summary Badges (เงินต้น/ดอกเบี้ย/ค่าดำเนินการ/ค่าปรับ/ค่าปลดล็อก/ยอดหนี้รวม) ด้านขวาบนตาราง tab เป้าเก็บหนี้ แปรผันตามฟิลเตอร์
- [x] P13-4: เพิ่มคอลัมน์ "ประเภทเครื่อง" และฟิลเตอร์ประเภทเครื่อง + เดือน-ปีที่อนุมัติ + เดือน-ปีที่ต้องชำระ ใน tab ยอดเก็บหนี้
- [x] P13-5: เพิ่ม Summary Badges (เงินต้น/ดอกเบี้ย/ค่าดำเนินการ/ค่าปรับ/ค่าปลดล็อก/ส่วนลด/ชำระเกิน/หนี้เสีย/ยอดที่ชำระรวม) ด้านขวาบนตาราง tab ยอดเก็บหนี้ แปรผันตามฟิลเตอร์

## Phase 14 — Bug Fixes

- [x] P14-1: แก้ไข bug งวดปัจจุบัน (sky-50 highlight) ไม่เลื่อนไปงวดถัดไปหลัง due_date ผ่านไปแล้ว (เช่น due_date 23/04 แต่วันนี้ 24/04 ยังแสดงงวดที่ 1 เป็น current)


## Phase 15 — Filter Order & UI Fixes

- [ ] P15-1: เรียงลำดับฟิลเตอร์ในเป้าเก็บหนี้: ค้นหา > เดือน-ปีที่อนุมัติ > เดือน-ปีที่ต้องชำระ > สถานะหนี้ > ประเภทเครื่อง
- [ ] P15-2: เพิ่มฟิลเตอร์ประเภทเครื่อง (Multiple choice) ในเป้าเก็บหนี้
- [ ] P15-3: เรียงลำดับฟิลเตอร์ในยอดเก็บหนี้: ค้นหา > เดือน-ปีที่อนุมัติ > เดือน-ปีที่ต้องชำระ > สถานะหนี้ > ประเภทเครื่อง
- [ ] P15-4: แก้ยอดที่ชำระรวมในยอดเก็บหนี้ไม่รวมส่วนลด (เป็นยอดเงินที่เก็บเข้ามาจริงๆ)
- [ ] P15-5: ลด padding พื้นที่ด้านล่างตารางในหน้าข้อมูลสัญญา

## Phase 16 — Bug Fixes

- [ ] P16-1: แก้ไข bug เป้าเก็บหนี้ไม่แสดงยอดชำระเกิน (overpaid carry-forward) จากงวดก่อนหน้าในงวดถัดไป เช่น งวดที่ 1 ชำระเกิน 1,010 แต่งวดที่ 2 ไม่แสดงว่ามียอดชำระเกินมาหักออก
- [x] P16-2: แก้ Summary Badge ยอดที่ชำระรวม ให้ใช้ p.total (total_paid_amount จาก API) แทนสูตรคำนวณเอง — รวม overpaid ด้วย ไม่รวม discount
- [x] P16-3: ตรวจสอบค่าดำเนินการใน payment transactions — debtDb.ts ส่ง fee_paid_amount จาก API มาแล้วถูกต้อง (TX2 fee=80 คือค่าจริงจาก API ไม่ใช่ bug)
- [x] P16-4: แก้ bug วันที่ต้องชำระงวดที่ 1 ในเป้าเก็บหนี้แสดงผิด — แก้ไขแล้วใน P16-5 (fixOutOfOrderDueDates)
- [x] P16-5: เพิ่ม fixOutOfOrderDueDates() helper ใน debtDb.ts — fix due_date ผิดลำดับ in-memory (CT0226-SRI005-1183-01 p1: 2027-01-05 → 2026-03-05 ✓) ไม่แก้ DB ดังนั้น sync ใหม่ไม่ทับ
- [x] P16-6: แก้ bug เป้าเก็บหนี้ — paidInFullButZeroedByApi ยัง apply overpaidApplied carry-forward ได้ (CT0226-SNI001-0978-01 งวด 2 แสดง 980.00 ✓)

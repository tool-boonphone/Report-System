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
- [x] สำรวจใน DB/API ว่ามี field ไหนเก็บ "ยอดขายเครื่อง" สำหรับสัญญาหนี้เสีย — พบว่า sale_price อยู่ใน contracts.raw_json, finance_amount อยู่ใน DB column, total_paid = SUM(payment_transactions.amount)
- [x] ออกแบบหน้า/แท็บใหม่: "สรุปกำไร/ขาดทุนจากหนี้เสีย" — สร้างหน้า BadDebtSummary.tsx ที่ /bad-debt-summary
- [x] สูตรคำนวณกำไร/ขาดทุน: profitLoss = totalPaid - financeAmount (ยอดที่เก็บได้ทั้งหมด − ยอดจัดไฟแนนซ์)
- [x] UI แสดง sale_price (ราคาขายเครื่อง) เป็นคอลัมน์แยกในตาราง BadDebtSummary — Export Excel ใน Phase 19 (ยังไม่ implement, deferred)

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
- [x] **Deferred**: ตรวจซ้ำ FF365 suspended_at/bad_debt_at — null ทั้งหมด (171,363 installments) เหมือน Boonphone — ใช้ approximation (due_date ของงวดแรกที่ status=ระงับ/ยกเลิก) ถูกต้อง

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
- [x] debtDb.ts: isArrears = มียอดค้างจากงวดก่อนเท่านั้น (ไม่ใช่ค่าปรับของงวดตัวเอง) — ✅ hasCarryFromPrior = priorPenalty > 0.005 || priorUnlockFee > 0.005 (line 1169)
- [x] DebtReport.tsx: Switch เฉพาะเงินต้น=เปิด → penalty/unlockFee = 0 ทุกงวด (ไม่มีข้อยกเว้น) — ✅ line 1177 principalOnly ? 0 : (inst.penalty ?? 0)
- [x] debtDb.ts/DebtReport.tsx: penalty/unlockFee แสดงเฉพาะงวดปัจจุบัน งวดอนาคต = 0 — ✅ line 1025-1027 isFuturePeriod ? 0 : rawPenalty
- [x] DebtReport.tsx: สิ้นสุดสัญญา — งวดที่ผ่านมาแล้ว (dueDate < today) ต้องเป็นสีเทา 0 เหมือน isSuspended — ✅ dimmed = closed || suspended → gray-100 bg + gray-400 italic
- [x] TypeScript 0 errors + tests + commit + push + checkpoint — ✅ 63/64 pass

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
- [x] P12-1: ตรวจสอบ root cause ของ bug วันที่ต้องชำระงวดที่ 1 อยู่หลังงวดที่ 2 (CT0226-SRI005-1183-01: งวด1=2027-01-05, งวด2=2026-04-05) — data anomaly จาก API (1 contract เดียว) ไม่ใช่ bug ใน code
- [x] P12-2: แก้ไข debtDb.ts ให้เรียงลำดับ installments ตาม due_date ก่อนใช้งาน — ✅ fixOutOfOrderDueDates() ใน debtDb.ts (duplicate ของ line 449)
- [x] P12-3: ตรวจสอบว่ามีสัญญาอื่นที่มีปัญหาเดียวกันหรือไม่ — fixOutOfOrderDueDates() ใน debtDb.ts จัดการแล้ว

### Phase 13 — DebtReport UX Improvements (5 items)
- [x] P13-1: แก้ไข Contextual Highlight ให้ชัดเจนบนทุก row type (งวดปัจจุบัน/ปิดค่างวด/สีแดง/สีเทา) โดยใช้ outline/ring แทน bg เพื่อไม่ให้กลืนกับสีพื้นหลังของ row
- [x] P13-2: เพิ่มฟิลเตอร์ "เดือน-ปีที่อนุมัติสัญญา" และ "เดือน-ปีที่ต้องชำระ" แบบ Multiple choice ใน tab เป้าเก็บหนี้
- [x] P13-3: เพิ่ม Summary Badges (เงินต้น/ดอกเบี้ย/ค่าดำเนินการ/ค่าปรับ/ค่าปลดล็อก/ยอดหนี้รวม) ด้านขวาบนตาราง tab เป้าเก็บหนี้ แปรผันตามฟิลเตอร์
- [x] P13-4: เพิ่มคอลัมน์ "ประเภทเครื่อง" และฟิลเตอร์ประเภทเครื่อง + เดือน-ปีที่อนุมัติ + เดือน-ปีที่ต้องชำระ ใน tab ยอดเก็บหนี้
- [x] P13-5: เพิ่ม Summary Badges (เงินต้น/ดอกเบี้ย/ค่าดำเนินการ/ค่าปรับ/ค่าปลดล็อก/ส่วนลด/ชำระเกิน/หนี้เสีย/ยอดที่ชำระรวม) ด้านขวาบนตาราง tab ยอดเก็บหนี้ แปรผันตามฟิลเตอร์

## Phase 14 — Bug Fixes

- [x] P14-1: แก้ไข bug งวดปัจจุบัน (sky-50 highlight) ไม่เลื่อนไปงวดถัดไปหลัง due_date ผ่านไปแล้ว (เช่น due_date 23/04 แต่วันนี้ 24/04 ยังแสดงงวดที่ 1 เป็น current)


## Phase 15 — Filter Order & UI Fixes

- [x] P15-1: เรียงลำดับฟิลเตอร์ในเป้าเก็บหนี้: ค้นหา > เดือน-ปีที่อนุมัติ > เดือน-ปีที่ต้องชำระ > สถานะหนี้ > ประเภทเครื่อง — ✅ ถูกต้องแล้ว
- [x] P15-2: เพิ่มฟิลเตอร์ประเภทเครื่อง (Multiple choice) ในเป้าเก็บหนี้ — ✅ มีอยู่แล้ว
- [x] P15-3: เรียงลำดับฟิลเตอร์ในยอดเก็บหนี้: ค้นหา > เดือน-ปีที่อนุมัติ > เดือน-ปีที่ต้องชำระ > สถานะหนี้ > ประเภทเครื่อง — ✅ ถูกต้องแล้ว
- [x] P15-4: แก้ยอดที่ชำระรวมในยอดเก็บหนี้ไม่รวมส่วนลด (เป็นยอดเงินที่เก็บเข้ามาจริงๆ) — ✅ ใช้ p.total = total_paid_amount จาก API
- [x] P15-5: ลด padding พื้นที่ด้านล่างตารางในหน้าข้อมูลสัญญา — ✅ ทำแล้วใน P17-1

## Phase 16 — Bug Fixes

- [x] P16-1: แก้ไข bug เป้าเก็บหนี้ไม่แสดงยอดชำระเกิน (overpaid carry-forward) — แก้ regex typo /-(d+)$/ → /-(\d+)$/ ใน debtDb.ts line 716 ทำให้ overpaidByContractPeriod ถูก populate ถูกต้อง
- [x] P16-2: แก้ Summary Badge ยอดที่ชำระรวม ให้ใช้ p.total (total_paid_amount จาก API) แทนสูตรคำนวณเอง — รวม overpaid ด้วย ไม่รวม discount
- [x] P16-3: ตรวจสอบค่าดำเนินการใน payment transactions — debtDb.ts ส่ง fee_paid_amount จาก API มาแล้วถูกต้อง (TX2 fee=80 คือค่าจริงจาก API ไม่ใช่ bug)
- [x] P16-4: แก้ bug วันที่ต้องชำระงวดที่ 1 ในเป้าเก็บหนี้แสดงผิด — แก้ไขแล้วใน P16-5 (fixOutOfOrderDueDates)
- [x] P16-5: เพิ่ม fixOutOfOrderDueDates() helper ใน debtDb.ts — fix due_date ผิดลำดับ in-memory (CT0226-SRI005-1183-01 p1: 2027-01-05 → 2026-03-05 ✓) ไม่แก้ DB ดังนั้น sync ใหม่ไม่ทับ
- [x] P16-6: แก้ bug เป้าเก็บหนี้ — paidInFullButZeroedByApi ยัง apply overpaidApplied carry-forward ได้ (CT0226-SNI001-0978-01 งวด 2 แสดง 980.00 ✓)

## Phase 17 — UI/UX Fixes

- [x] P17-1: ลด padding ด้านล่างตารางในหน้าข้อมูลสัญญาให้เท่ากับหน้าอื่นๆ
- [x] P17-2: แก้ z-index เส้นกรอบ hover ให้อยู่บนสุดเสมอ (ไม่ถูก BG ของแถวอื่นทับ)
- [x] P17-3: เปลี่ยน auto sync schedule จาก hourly (08:00-19:00) เป็นวันละครั้ง เวลา 06:00 น. (ทั้ง Boonphone และ Fastfone)
- [x] P17-4: เพิ่ม progress bar % + elapsed time + estimated remaining time แทนปุ่มรีเฟรชขณะ sync กำลังทำงาน
- [x] P17-5: เพิ่มไอคอนหน้าเมนู ข้อมูลสัญญา และ รายงานหนี้ ใน Sidebar navigation

### Phase 12 — Bug Fix: Installment Date Ordering (DONE)
- [x] P12-2: แก้ไข fixOutOfOrderDueDates() ใน debtDb.ts — เปลี่ยน anchor strategy จาก "smallest due_date = anchor ของ period นั้น" เป็น "smallest due_date = anchor ของ period 1 เสมอ" แล้ว rebuild ทุก period = anchor + (period-1) months — ทำให้ CT0226-SRI005-1183-01 งวด 1 แสดง 2026-04-05 (เม.ย.) แทน 2026-03-05 (มี.ค.) และงวด 10 แสดง 2027-01-05 (ม.ค.) แทน 2026-12-05 (ธ.ค.)
- [x] Tests: 63/64 pass + TypeScript: 0 errors + commit + push + checkpoint

### Phase 18 — Fastfone365 Full Audit & Fix

- [x] P18-1: ล้าง stale sync locks ของ Fastfone365 (in_progress ค้างอยู่) — ✅ ล้างแล้ว
- [x] P18-2: Trigger sync Fastfone365 ใหม่ทั้งหมด (contracts → installments → payments) — ✅ sync สำเร็จ 292,680 rows
- [x] P18-3: ตรวจสอบ API Fastfone365 — field mapping, response structure vs Boonphone — ✅ พบ mulct=penalty_due, installmentExternalId={extId}-{period}
- [x] P18-4: ตรวจสอบ installments Fastfone365 ใน DB — due_date ordering, raw_json fields — ✅ 171,363 installments
- [x] P18-5: ตรวจสอบ payments Fastfone365 ใน DB — ✅ 103,508 payments, ใช้ installmentExternalId แทน receipt_no
- [x] P18-6: ตรวจสอบ UI Contracts page สำหรับ Fastfone365 — ✅ 17,809 contracts แสดงผลถูกต้อง
- [x] P18-7: ตรวจสอบ UI Debt Report (เป้าเก็บหนี้/ยอดเก็บหนี้) สำหรับ Fastfone365 — ✅ debtDb.ts รองรับ FF365 adapter
- [x] P18-8: แก้ไข mappers/debtDb/API ให้ Fastfone365 ทำงานเหมือน Boonphone ทุกด้าน — ✅ เพิ่ม isFF365 adapter ใน debtDb.ts + listDebtCollected ใช้ installmentExternalId
- [x] P18-9: Run tests (63 pass, 1 skip) + save checkpoint + commit 3568c47 (GitHub push failed: token expired)

### Phase 19 — Fastfone365 UI Fixes + Phase 9k Bad Debt Summary

#### P19-1: FF365 ยอดเก็บหนี้ — ซ่อน principal/interest/fee สำหรับ FF365
- [x] Backend `debtDb.ts`: เพิ่ม `hasPrincipalBreakdown: boolean` ใน `listDebtCollected` return (true=Boonphone, false=FF365)
- [x] Frontend `DebtReport.tsx`: ใช้ `hasPrincipalBreakdown` เพื่อแสดง "-" แทน "0.00" สำหรับ FF365 ใน principal/interest/fee columns
- [x] Frontend `DebtReport.tsx`: ซ่อน Summary Badges เงินต้น/ดอกเบี้ย/ค่าดำเนินการ สำหรับ FF365

#### P19-2: Phase 9k — หน้าสรุปกำไร/ขาดทุนจากหนี้เสีย
- [x] สำรวจ DB: FF365 มี 3,123 สัญญาหนี้เสีย, `sale_price` อยู่ใน raw_json, `finance_amount` อยู่ใน DB column
- [x] Backend `server/badDebtDb.ts`: `getBadDebtSummary({ section, approveMonth? })` — query contracts JOIN payments, คำนวณ profitLoss = totalPaid - financeAmount
- [x] Backend `server/routers/badDebt.ts`: `badDebtRouter` + `badDebtViewProcedure` (permission: bad_debt_summary.view)
- [x] Backend `server/routers.ts`: ลงทะเบียน `badDebtRouter`
- [x] Frontend `client/src/pages/BadDebtSummary.tsx`: หน้าสรุปกำไร/ขาดทุน — Summary cards + ตารางรายสัญญา + filter + sort
- [x] Frontend `client/src/App.tsx`: เพิ่ม route `/bad-debt-summary`
- [x] Frontend `client/src/components/TopNav.tsx`: เพิ่ม nav item "สรุปหนี้เสีย" (icon: TrendingDown)
- [x] Shared `shared/const.ts`: เพิ่ม `bad_debt_summary` ใน MENU_CODES + MENU_LABELS
- [x] Unit tests `server/badDebt.test.ts`: 14 tests ครอบ row calculation + summary calculation
- [x] TypeScript: 0 errors, Tests: 74/76 pass (1 fail = pre-existing admin.access timeout, 1 skip = FF365 creds)

### Phase 20 — แก้ไข TopNav ใน BadDebtSummary

- [x] แก้ไข BadDebtSummary.tsx ให้ใช้ AppShell (TopNav) เหมือนหน้า Contracts และ DebtReport — ลบ custom header div ออก

### Phase 21 — Performance: หน้ารายงานหนี้ Fastfone365 โหลดเร็วขึ้น (ไม่แบ่งหน้า)

- [x] วิเคราะห์สาเหตุที่โหลดช้า: contracts 1.7s + installments 3.5s + payments = รวม ~6-7 วินาที (DB query ล้วนหลัก, ไม่ใช่ render)
- [x] DB indexes: ไม่เพิ่ม (query ใช้ full-table scan เพราะ listDebtTarget ต้องการ contracts ทุก status เพื่อคำนวณ isClosed/isSuspended)
- [x] Server-side in-memory cache (TTL 5 นาที) — สร้าง `server/debtCache.ts` + เรียกใน `server/routers/debt.ts`
- [x] Cache invalidation หลัง sync เสร็จ — `invalidateDebtCache(section)` ใน `server/sync/runner.ts`
- [x] Virtual scrolling ใน UI — มีอยู่แล้ว (@tanstack/react-virtual, overscan: 10) ไม่ต้องเพิ่ม

### Phase 22 — Performance + UX + Export Excel

- [x] Pre-warm cache: สร้าง `server/debtPrewarm.ts` + เรียกใน `server/_core/index.ts` (non-blocking, background setTimeout 2s)
- [x] Progress indicator: elapsed time counter + ข้อความแจ้งว่าครั้งถัดไปจะเร็วขึ้น ใน DebtReport.tsx loading state
- [x] Export Excel: ปุ่ม Export Excel ใน BadDebtSummary TopNav + route `/api/export/bad-debt` + `handleBadDebtExport` ใน exportExcel.ts

### Phase 23 — Filter Enhancements ใน DebtReport (cell-level hiding)

- [x] Feature 1: ฟิลเตอร์เดือน-ปีที่ต้องชำระ (dueDateFilter) → ซ่อน cell ของ period ที่ dueDate ไม่ตรงกับเดือนที่เลือก (แสดง "-" แทน) + Badge คำนวณเฉพาะ period ที่ตรง
- [x] Feature 2: เพิ่ม date picker filter (ปฏิทิน) ทั้ง 2 tab → target=วันที่ที่ต้องชำระ, collected=วันที่ที่ชำระ → ซ่อน cell ที่ไม่ตรงวันที่เลือก + Badge คำนวณเฉพาะวันที่เลือก

### Phase 24 — Bug fix: overpaid ของงวดก่อนหน้าไม่ถูกนำมาหักในเป้าเก็บหนี้

- [x] ตรวจสอบ DB: overpaid_amount, installments.amount ของสัญญา CT0226-SBR001-0909-01
- [x] วิเคราะห์: API ส่ง apiAmount = baseline (ไม่หักให้) → else branch ต้องหัก overpaidApplied เอง
- [x] แก้ไข debtDb.ts else branch: ถ้า apiEqualsBaseline && overpaidApplied > 0 → amount = max(0, apiAmount - overpaidApplied)

### Phase 25 — Filter Order + Date Filter Behavior

- [x] เรียงลำดับ filter ใหม่: target tab = ค้นหา > วันที่ > เดือน-ปีที่อนุมัติ > เดือน-ปีที่ต้องชำระ > สถานะหนี้ > ประเภทเครื่อง > เฉพาะเงินต้น
- [x] เรียงลำดับ filter ใหม่: collected tab = ค้นหา > วันที่ > เดือน-ปีที่อนุมัติ > เดือน-ปีที่ต้องชำระ > สถานะหนี้ > ประเภทเครื่อง
- [x] collected tab date filter: row-level hiding (filteredRows) + cell masking สำหรับ period ที่ไม่ตรงวันที่
- [x] filteredRows ลำดับความสำคัญ: approveDateFilter > dueDateExact > dueDateFilter > statusFilter > productTypeFilter

### Phase 26 — Badge ยอดเก็บหนี้: สูตรยอดรวม + Toggle ตา
- [x] แก้สูตรยอดที่ชำระรวม = เงินต้น + ดอกเบี้ย + ค่าดำเนินการ + ค่าปรับ + ค่าปลดล็อก + ชำระเกิน + หนี้เสีย (ไม่รวมส่วนลด)
- [x] เพิ่ม toggle เปิด/ปิดตา (Eye icon) ใน Badge แต่ละตัวของ collected tab — default = เปิด (นำมาคิดในยอดรวม)
- [x] ส่วนลด: ปิดตาตลอด ไม่สามารถเปิดได้ ไม่นำมาคิดในยอดรวม
- [x] Badge ที่ปิดตา: แสดงตัวเลขแบบ dimmed (opacity-40) และไม่นำมารวมใน "ยอดที่ชำระรวม"

### Phase 27 — แสดงข้อความ "-หักชำระเกิน" กำกับในงวดที่ถูกหักยอดเกิน

- [x] ตรวจสอบว่า `overpaidApplied` field ถูกส่งมาใน TargetRow installments แล้ว (ยืนยันผ่าน API call: overpaidApplied=50)
- [x] ตรวจสอบ DB: พบ 63 สัญญาที่มี overpaid carry-forward (Boonphone)
- [x] แก้ไข DebtReport.tsx: เปลี่ยนเงื่อนไข annotation จาก `overpaidApplied > 0 && baselineAmount > amount` เป็น `overpaidApplied > 0.009` เพียงอย่างเดียว (เงื่อนไขเดิมไม่ทำงานเมื่อ penalty ถูกบวกเข้า amount ทำให้ amount = baseline)
- [x] ทดสอบ TypeScript (ไม่มี error) + ยืนยัน UI แสดง (-หักชำระเกิน: 50.00) ในงวดที่ 2 ของ CT0226-SBR001-0909-01 แล้ว

### Phase 28 — Bug fix: collected tab filter วันที่/เดือนที่ชำระ ต้องซ่อน payment sub-row ที่ไม่ตรงออกด้วย

- [x] อ่านโค้ด collected tab: พบว่า dueDateFilter ใช้ dueDate เดียวกันทั้ง  2 tab แต่ collected tab ควรใช้ paidAt
- [x] แก้ไข: dueDateOptions ใน collected tab ใช้ paidAt เดือน
- [x] แก้ไข: filteredRows step 3 ใน collected tab กรองตาม paidAt เดือน
- [x] แก้ไข: collectedSummary badge กรอง payment ตาม paidAt เดือน
- [x] แก้ไข: paymentsByPeriod กรอง payment ตาม paidAt เดือนก่อน push เข้า map
- [x] แก้ไข: isCollectedCellMasked เพิ่มเงื่อนไข dueDateFilter (pays.length === 0)
- [x] แก้ไข: filter label เปลี่ยนเป็น "เดือน-ปีที่ชำระ" ใน collected tab
- [x] ทดสอบ TypeScript (ไม่มี error) เรียบร้อย

### Phase 29 — Export Excel รองรับ filter วันที่/เดือนที่ชำระ

- [x] อ่านโค้ด export handler (frontend handleExport + backend /api/export/debt)
- [x] แก้ไข frontend: ส่ง dueDateExact, dueDateFilter, approveDate, productType ใน export URL params
- [x] แก้ไข backend: รับและ filter ด้วย dueDateExact/dueDateFilter/approveDate/productType/status/search (target: dueDate, collected: paidAt)
- [x] cell-level masking: target skip installment ที่ไม่ตรง filter; collected filter payment ก่อน group
- [x] isClosed/isSuspended/isBadDebt → 0 (plain number, ไม่มีข้อความ); overpaidApplied → netAmount (ตัวเลขล้วน)
- [x] ทดสอบ TypeScript (ไม่มี error) เรียบร้อย
- [x] Phase 29 เพิ่มเติม: Excel export — ไม่มีข้อความ (-หักชำระเกิน) ใส่เป็นตัวเลขล้วน; สถานะ ระงับสัญญา/ปิดค่างวดแล้ว/หนี้เสีย ให้ใส่เป็น 0

### Phase 30 — Bug fix: dueDateExact filter ใน collected tab ไม่ซ่อน payment sub-row ที่ paidAt ไม่ตรง

- [x] ตรวจสอบ: paymentsByPeriod บรรทัด 1139 มีเฉพาะ dueDateFilter แต่ไม่มี dueDateExact
- [x] แก้ไข: เพิ่ม `if (dueDateExact && p.paidAt?.slice(0,10) !== dueDateExact) continue;` ใน paymentsByPeriod loop
- [x] ทดสอบ TypeScript (ไม่มี error) เรียบร้อย

### Phase 31 — ตัดสัญญาสถานะ "ยกเลิกสัญญา" ออกจากรายงานหนี้ทั้งหมด

- [x] ตรวจสอบ debtDb.ts: พบว่า listDebtTarget SQL query ไม่มี filter status เลย
- [x] เพิ่ม `AND (status IS NULL OR status != 'ยกเลิกสัญญา')` ใน listDebtTarget SQL (listDebtCollected reuse baseRows จึง filter ออกอัตโนมัติ)
- [x] ทดสอบ TypeScript (ไม่มี error) เรียบร้อย

### Phase 31 — ตัดสัญญาสถานะ "ยกเลิกสัญญา" ออกจากรายงานหนี้ทั้งหมด

- [x] ตรวจสอบ debtDb.ts: พบว่า listDebtTarget SQL query ไม่มี filter status เลย
- [x] เพิ่ม `AND (status IS NULL OR status != 'ยกเลิกสัญญา')` ใน listDebtTarget SQL (listDebtCollected reuse baseRows จึง filter ออกอัตโนมัติ)
- [x] ทดสอบ TypeScript (ไม่มี error) เรียบร้อย

#### Phase 32 — แก้ไขปัญหา Fastfone365 รายงานหนี้โหลดนาน/502 timeout
- [x] ตรวจสอบ server log และ prewarm cache สำหรับ Fastfone365 (พบว่า 502 Bad Gateway เมื่อ cache miss)
- [x] เพิ่ม Cache TTL จาก 5 นาที → 30 นาที ใน debtCache.ts
- [x] เพิ่ม stale-while-revalidate: background refresh เมื่อ cache ใกล้หมด (< 5 นาที)
- [x] เพิ่ม timeout 120 วินาที ใน tRPC client (main.tsx) เพื่อรอกรณี cache miss
- [x] เพิ่ม retry: 1, staleTime: 25 นาที ใน query options (DebtReport.tsx)
- [x] ปรับ loading message ให้แสดงเวลาที่ใช้ไปและ progress bar ที่ถูกต้องกว่าเดิม
- [x] เพิ่ม error state พร้อมปุ่ม "ลองใหม่" เมื่อเกิด 502/timeout
- [x] TypeScript: 0 errors, Server: running, prewarm: all sections cached
- [x] commit + checkpoint

### Phase 33 — แก้ไข 503 timeout + gzip compression + Pagination
- [x] เพิ่ม HTTP gzip compression ใน Express server (compression middleware)
- [x] สร้าง Streaming endpoint /api/debt/stream/target และ /api/debt/stream/collected
- [x] ส่งข้อมูลเป็น chunked transfer encoding เพื่อป้องกัน proxy timeout
- [x] ส่ง hasPrincipalBreakdown ใน streaming response metadata
- [x] เปลี่ยน DebtReport.tsx จาก tRPC query → streaming fetch (bypass proxy timeout)
- [x] เพิ่ม pagination state: currentPage, pageSize (default 100)
- [x] เพิ่ม pagedRows: slice filteredRows ตาม page/pageSize
- [x] เพิ่ม Pagination UI ด้านล่างตาราง (เลขหน้า, กด prev/next, เลือก 50/100/200/500)
- [x] Reset page 1 เมื่อ filter เปลี่ยน หรือ section เปลี่ยน
- [x] TypeScript: 0 errors, Server: running
- [x] commit + checkpoint

### Phase 34 — แก้ไขคอลัมน์หนี้เสียและ UI ตารางยอดเก็บหนี้
- [ ] อ่าน debtDb.ts เพื่อเข้าใจโครงสร้างการคำนวณยอดหนี้เสีย (badDebt field)
- [ ] แก้ไข debtDb.ts: ลงยอดหนี้เสียในคอลัมน์ badDebt ให้ถูกต้อง (ไม่ใช่ yodtChararuam)
- [ ] แก้ไข DebtReport.tsx: ไฮไลท์ BG งวดปัจจุบัน (สีเขียวอ่อน)
- [ ] แก้ไข DebtReport.tsx: BG สีแดงอ่อนสำหรับงวดที่ผ่านมาแล้วแต่ไม่มียอดชำระ
- [ ] ทดสอบ TypeScript + commit + checkpoint

### Phase 35 — บันทึกยอดหนี้เสียลง DB ต่อสัญญา (Bad Debt Storage)

**Business Rule ที่ตกลงกัน:**
- `contract.status = "หนี้เสีย"` → ขายเครื่องแล้ว → มียอดหนี้เสีย
- `contract.status = "ยกเลิกสัญญา"` + มี payment ในวันเดียวกับวันที่เปลี่ยนสถานะ → แอดมินบันทึกผิด แต่ตีความเป็นหนี้เสีย
- `contract.status = "ระงับสัญญา"` → ได้เครื่องคืนแต่ยังไม่ขาย → ไม่มียอดหนี้เสีย
- Logic เดียวกันทั้ง Boonphone และ FF365

- [ ] เพิ่ม columns ใน `contracts` table: `bad_debt_amount` DECIMAL(12,2), `bad_debt_date` VARCHAR(20), `suspended_from_period` INT
- [ ] สร้าง migration SQL และ apply ผ่าน webdev_execute_sql
- [ ] อัปเดต `drizzle/schema.ts` ให้ตรงกับ DB
- [ ] สร้าง `computeAndStoreBadDebt(section)` function ใน `server/sync/runner.ts` หรือ `server/debtDb.ts`
  - ดึง contracts ที่ status = "หนี้เสีย" หรือ "ยกเลิกสัญญา" (ที่มี payment ในวันเดียวกับวันเปลี่ยนสถานะ)
  - ใช้ logic เดิม: หา suspendedFromPeriod จาก installment แรกที่ status เป็น suspend code
  - รวมยอด payment ที่ isBadDebtRow = true → bad_debt_amount
  - หา bad_debt_date จาก deriveBadDebtDate
  - UPDATE contracts SET bad_debt_amount, bad_debt_date, suspended_from_period
- [ ] เรียก `computeAndStoreBadDebt` เป็น Step 6 หลัง syncPayments ใน runner.ts
- [ ] แก้ไข `listDebtTarget` SQL query ให้ดึง bad_debt_amount, bad_debt_date, suspended_from_period จาก contracts table โดยตรง (แทนการคำนวณใหม่)
- [ ] ทดสอบ TypeScript + ตรวจสอบ DB ว่า bad_debt_amount ถูกต้อง
- [ ] commit + checkpoint

### Phase 26 — Bad Debt Display Fixes

- [ ] P26-1: ซ่อน real payment (ยอดขายเครื่อง/ยอดรวม เช่น 20,000) ออกจากตารางยอดเก็บหนี้สำหรับสัญญาหนี้เสีย — real payment คือ external_id เป็นตัวเลข (ไม่ใช่ "pay-{id}-{n}") ไม่ควรแสดงในตารางเพราะกระจายลงงวดแล้ว
- [ ] P26-2: เพิ่ม tooltip ที่ยอดหนี้เสียที่กระจายลงงวด (isBadDebtRow) — แสดงหมายเหตุ เช่น "ยอดขายเครื่อง 20,000 บาท (06/04/2569)"
- [ ] P26-3: แก้ไข overpayment ใน CT0126-SNI017-22216-01 — ยอดชำระเกินต้องถูกนำไปหักงวดถัดไปและแสดงข้อความกำกับ

### Phase 27 — Bad Debt Display Refactor (ใหม่)
- [x] ตัด synthetic payments (pay-{id}-{n}) และ real payment ออกจากตารางสำหรับสัญญาหนี้เสีย
- [x] สร้าง 1 bad debt row: งวด = งวดถัดจากงวดสุดท้ายที่ชำระปกติ (ถ้าไม่มีการชำระ = งวด 1), badDebt = bad_debt_amount, คอลัมน์อื่น = 0, paidAt = bad_debt_date

### Phase 28 — Period Ordering & Overpaid Fix
- [ ] แก้ไข assignPayPeriods: ลำดับงวดข้ามในตารางยอดเก็บหนี้ (เช่น CT0126-PII012-20958-01 แสดงงวด 2-1, 3-1 แต่ไม่มีงวด 1)
- [ ] แก้ไข overpaid carry-forward: ยอดชำระเกินต้องหักงวดถัดไปในเป้าเก็บหนี้ ไม่ใช่งวดเดียวกัน

### Fix: FF365 bad_debt_amount = ยอดขายเครื่อง (real payment ล่าสุด ไม่ใช่ sum)
- [x] Fix computeAndStoreBadDebt ใน runner.ts: bad_debt_amount = total_paid_amount ของ real payment ล่าสุด (ไม่ใช่ sum ทั้งหมด)
- [x] Fix display logic ใน debtDb.ts: real payment ปกติ (ก่อน bad debt) แสดงในตาราง, bad debt row = bad_debt_amount ใหม่
- [x] Re-sync bad_debt_amount สำหรับสัญญา FF365 ทั้งหมดใน DB

### Fix: FF365 duplicate payment rows (synthetic payments หลุดผ่าน normalPayments filter)
- [x] แก้ normalPayments filter ใน debtDb.ts: ตัด synthetic payments (external_id ไม่ใช่ตัวเลข) ออกทั้งหมด ไม่ว่า paid_at จะตรงกับ bad debt date หรือไม่

### Fix: FF365 period assignment offset หลังแก้ synthetic filter
- [x] แก้ debtDb.ts bad debt branch: re-assign periods จาก real payments เท่านั้น (ไม่ใช้ assigned ที่ include synthetic ทำให้ cursor offset ผิด)

### Phase 40 — Unify Boonphone + FF365 ใช้โค้ดชุดเดียวกัน
- [x] P40-1: Unify sync/runner.ts: ให้ FF365 ใช้ syncInstallments Boonphone path (bulk endpoint) แทน syncInstallmentsFromDetail
- [x] P40-2: Unify sync/runner.ts: ลบ isFF365 branch ใน syncInstallments, enrichContractsWithDeviceIds
- [x] P40-3: Unify sync/runner.ts: ลบ isFF365 branch ใน computeAndStoreBadDebt — ใช้ Boonphone logic เดียวกัน
- [x] P40-4: Unify debtDb.ts: ลบ isFF365 branch ใน SQL query installments (listDebtTarget) — ใช้ Boonphone fields เดียวกัน
- [x] P40-5: Unify debtDb.ts: ลบ isFF365 branch ใน closedByContract detection — ใช้ TXRTC logic เดียวกัน
- [x] P40-6: Unify debtDb.ts: ลบ isFF365 branch ใน suspend codes — ใช้ Boonphone codes เดียวกัน
- [x] P40-7: Unify debtDb.ts: ลบ isFF365 branch ใน listDebtCollected — ใช้ Boonphone path เดียวกัน
- [x] P40-8: Unify mappers.ts: ให้ FF365 installments ใช้ field mapping เดียวกับ Boonphone (rawJson fields)
- [x] P40-9: ทดสอบ TypeScript, restart server, commit + checkpoint

### Phase 41 — AI Chat Panel "น้องเป๋าตัง" (Side-by-Side Layout)
- [x] P41-1: สร้าง server/routers/ai.ts — AI chat tRPC router, query DB + LLM, userName parameter, system prompt น้องเป๋าตัง
- [x] P41-2: Register aiRouter ใน server/routers.ts
- [x] P41-3: สร้าง client/src/contexts/AiChatContext.tsx — share aiChatOpen state ระหว่าง TopNav และ AppShell
- [x] P41-4: เพิ่ม AiChatProvider ใน client/src/main.tsx
- [x] P41-5: แก้ TopNav.tsx — ใช้ useAiChat() แทน local state, gradient sparkle icon + animation, ลบ AIChatPanel ออก
- [x] P41-6: แก้ AppShell.tsx — side-by-side layout, marginRight เมื่อ panel เปิด, mount AIChatPanel
- [x] P41-7: เขียน AIChatPanel.tsx ใหม่ — fixed right panel, ใช้ useAiChat()/useAppAuth(), greeting message อัตโนมัติ, suggested prompts หลัง greeting
- [x] P41-8: เพิ่ม CSS animation animate-ai-sparkle ใน index.css
- [x] P41-9: TypeScript check ผ่าน, commit + push GitHub, checkpoint

### Fix: Production Fastfone365 โหลดไม่ได้ + Refresh progress bar
- [x] Fix-P1: เพิ่ม server.keepAliveTimeout + server.headersTimeout ใน server/_core/index.ts เพื่อป้องกัน proxy ตัด connection
- [x] Fix-P2: เพิ่ม fetchStream timeout จาก 120s เป็น 180s ใน DebtReport.tsx
- [x] Fix-P3: เพิ่ม keep-alive ping ใน debtStream.ts — ส่ง whitespace chunk ทุก 10 วินาทีระหว่างคำนวณ เพื่อป้องกัน proxy timeout
- [x] Fix-P4: แก้ progress bar ใน DebtReport.tsx ให้แสดงตั้งแต่วินาทีแรก (ไม่รอ 3 วินาที)
- [x] Fix-P5: save checkpoint + push GitHub + publish

### Phase 43 — True Streaming: ส่ง rows ระหว่างคำนวณ (แก้ Cloudflare 100s hard timeout)
- [x] P43-1: เพิ่ม listDebtTargetStream async generator ใน debtDb.ts ที่ yield rows ทีละ batch ระหว่างคำนวณ
- [x] P43-2: แก้ handleDebtStreamTarget ใน debtStream.ts ให้ใช้ NDJSON streaming เมื่อ cache miss
- [x] P43-3: เพิ่ม listDebtCollectedStream async generator ใน debtDb.ts
- [x] P43-4: แก้ handleDebtStreamCollected ใน debtStream.ts ให้ใช้ NDJSON streaming เมื่อ cache miss
- [x] P43-5: แก้ fetchStream ใน DebtReport.tsx ให้ parse NDJSON + แสดง progress ระหว่างโหลด
- [x] P43-6: แก้ error message ใน UI ให้แสดง string error ได้ถูกต้อง
- [x] P43-7: TypeScript check + commit + checkpoint + push

### Phase 44 — Fix: ยอดเก็บหนี้ Fastfone365 โหลดไม่ขึ้น
- [x] P44-1: ตรวจสอบ listDebtCollectedStream ว่า streaming ทำงานได้จริงไหม
- [x] P44-2: แก้ไข handleDebtStreamCollected ให้ streaming ทำงานได้จริง
- [x] P44-3: TypeScript check + checkpoint + push

### Phase 45 — Fix: เป้าเก็บหนี้ duplicate columns + ยอดเก็บหนี้ OOM/503
- [x] P45-1: วิเคราะห์สาเหตุ Bug 1 (target tab duplicate columns) — DB มี 14,000 duplicate installment rows (185,363 total แต่ distinct periods = 171,363)
- [x] P45-2: เพิ่ม `dedupInstByPeriod()` helper function ใน debtDb.ts — dedup per period โดยเก็บ row ที่มี amount สูงสุด
- [x] P45-3: เรียก `dedupInstByPeriod()` ใน `listDebtTarget` (non-stream) ก่อน `fixOutOfOrderDueDates`
- [x] P45-4: เรียก `dedupInstByPeriod()` ใน `listDebtTargetStream` ก่อน `fixOutOfOrderDueDates`
- [x] P45-5: เพิ่ม dedup per-period ใน `listDebtCollectedStream` (instByContract building)
- [x] P45-6: แก้ Bug 2 (collected tab OOM/503) — เปลี่ยน `listDebtCollectedStream` จาก "โหลด ALL 222K payments ก่อน" เป็น "โหลด payments per-batch" (~100 contracts × ~15 payments = ~1,500 rows ต่อ query แทน 222K rows ทั้งหมด)
- [x] P45-7: TypeScript check ผ่าน + ยืนยัน prewarm สำเร็จ (Boonphone: 10.8s, Fastfone365: 51.7s) + commit + push GitHub + checkpoint

### Phase 48 — เป้าเก็บหนี้: หักยอดชำระเกิน cascade ข้ามงวด
- [x] P48-1: วิเคราะห์ overpayment field ใน installments และ processContract ว่า overpayment ถูก store ที่ไหนและ format อย่างไร
- [x] P48-2: เพิ่ม cascade overpayment deduction logic ใน processContract (listDebtTargetStream) — หักยอดชำระเกินออกจาก totalAmount ของงวดนั้น แล้ว cascade ส่วนที่เหลือไปงวดถัดไปจนหมด
- [x] P48-3: เพิ่ม cascade overpayment deduction logic ใน listDebtTarget (non-stream) ด้วย
- [x] P48-4: TypeScript check ผ่าน (0 errors) + ลบ cascade pass เก่าออก
- [x] P48-5: แก้ cascade overpayment pass ให้หักในลำดับ ดอกเบี้ย → ค่าดำเนินการ → เงินต้น (ไม่ใช่หักยอดหนี้รวมโดยตรง) ใน listDebtTarget และ listDebtTargetStream
- [x] P48-6: ลบ cascade post-processing pass เก่า (double-deduction) ออกจากทั้ง 2 functions — overpaidApplied ต่อ period มาจาก DB แล้ว ไม่ต้องทำ cascade เพิ่มเติม

### Bug Fix — ยอดเก็บหนี้: สถานะหนี้ไม่แสดงผล
- [x] BugFix-Collected-Status-1: ตรวจสอบและแก้ไขคอลัมน์ "สถานะหนี้" ใน tab ยอดเก็บหนี้ไม่แสดงผล — แก้ listDebtCollectedStream ให้เพิ่ม due_date/paid_amount ใน installments query และเรียก deriveDebtStatus() เพื่อคำนวณ debtStatus ก่อน spread เข้า row

### Bug Fix — ยอดเก็บหนี้: ยอดผ่อนรวมหายไป
- [x] BugFix-Collected-TotalAmount-1: แก้ไข totalAmount (ยอดผ่อนรวม) หายไปใน tab ยอดเก็บหนี้ — เพิ่ม totalAmount/totalPaid/remaining ใน object c ของ listDebtCollectedStream โดยคำนวณจาก instList

### Bug Fix — เป้าเก็บหนี้/ยอดเก็บหนี้: โหลดครั้งแรก error
- [x] BugFix-Stream-503-1: แก้ไข HTTP 503 ครั้งแรกในเป้าเก็บหนี้ — เพิ่ม waitForPrewarmTarget/Collected ใน stream handler ให้รอ prewarm เสร็จก่อน serve (prewarm register promise ก่อน await ใน debtPrewarm.ts)
- [x] BugFix-Stream-JSON-1: แก้ไข JSON parse error ครั้งแรกในยอดเก็บหนี้ — ลบ keep-alive whitespace timer ออก (ทำให้ JSON เสีย) และให้ handler รอ prewarm เสร็จก่อน stream แทน

### Bug Fix — เป้าเก็บหนี้: ยอดหนี้รวมไม่เท่ากับ 0 เมื่อทุก component = 0
- [x] BugFix-TotalDebt-Zero-1: แก้ไข arrears pass (Phase 49) — ไม่ fallback ไป baselineAmount เมื่อ overpaidApplied > 0 เพราะ baseNet=0 ในกรณีนั้นหมายความว่า overpaid หักครบทุก component แล้ว (ถูกต้อง) ไม่ใช่ API ส่ง 0 มาผิด แก้ในทั้ง listDebtTarget และ listDebtTargetStream

### Phase 50 — แก้ไขหน้าภาพรวมหนี้ (DebtOverview) หลายจุด
- [x] P50-1: ลบเมนู "สรุปหนี้" ออกจาก sidebar navigation
- [x] P50-2: แก้สีหัวตาราง (header) ให้ข้อความไม่กลืนกับพื้นหลัง
- [x] P50-3: เรียงลำดับเดือนใหม่ เก่าสุดอยู่บนสุด + สามารถสลับได้ที่คอลัมน์เดือน
- [x] P50-4: เพิ่มปุ่มเปิด/ปิดตาของแต่ละเดือน (toggle visibility per row)
- [x] P50-5: เพิ่ม row ผลรวมล่างสุดของตาราง
- [x] P50-6: ย้าย toggle "เฉพาะเงินต้น" ไปไว้ในส่วนฟิลเตอร์
- [x] P50-7: เพิ่มปุ่ม Export Excel ของตารางภาพรวมหนี้ไว้ข้างฟิลเตอร์
- [x] P50-8: แก้ไขส่วนลดไม่ต้องขีดฆ่า
- [x] P50-9: แก้ไข aggregation penalty/unlockFee ให้ sum จากทุกงวดรวม isClosed ด้วย
- [~] P50-10: เดือน มี.ค. 69 และ เม.ษ. 69 — fmtMonthYear ถูกต้องแล้ว น่าจะเป็นข้อมูลจริงยังไม่มีใน cache (ต้อง deploy แล้ว prewarm ใหม่)
- [x] P50-11: ฟิลเตอร์สถานะสัญญา — statusFilter ใช้ debtStatus ทั้ง filteredTargetRows และ filteredCollectedRows อยู่แล้ว ปัญหาเดิมเพราะ debtStatus ของ collected rows ไม่ถูก set (แก้ไขแล้วใน BugFix-Collected-Status-1)
- [x] P50-12: ปรับวิธีโหลดข้อมูล — DebtOverview ใช้ stream endpoint เหมือนหน้ารายงานหนี้อยู่แล้ว (ไม่ต้องปรับ)

### Phase 51 — เปลี่ยนชื่อ "หนี้เสีย" → "ขายเครื่อง" ใน Badge/หัวตาราง
- [x] P51-1: เปลี่ยน Badge "หนี้เสีย" → "ขายเครื่อง" และหัวตาราง "ยอดหนี้เสีย (ยอดขายเครื่อง)" → "ขายเครื่อง" ใน tab ยอดเก็บหนี้ (DebtReport.tsx)
- [x] P51-2: เปลี่ยน Badge "หนี้เสีย" → "ขายเครื่อง" ในภาพรวมหนี้ (DebtOverview.tsx)

### Phase 52 — แก้ isClosed logic: ใช้ "งวดสุดท้ายที่ paid > 0" แทน maxNormalPeriod
- [x] P52-1: แก้ closedByContract ใน listDebtTarget ให้ใช้ max(period ที่ paid_amount > 0) แทน maxNormalPeriod จาก TXRTC
- [x] P52-2: แก้ closedByContract ใน listDebtTargetStream ให้ใช้ logic เดียวกัน
- [x] P52-3: TypeScript check ผ่าน 0 errors
- [x] P52-4: Checkpoint + Push GitHub

### Phase 53 — แก้ isClosed edge case + ซ่อน BG สีฟ้าสำหรับสัญญาพิเศษ
- [x] P53-1: แก้ isClosed — งวดที่ 1 (periodNo=1) แสดงยอดตั้งหนี้ปกติเสมอ แม้ maxNormalPeriod=1 (ใน listDebtTarget และ listDebtTargetStream)
- [x] P53-2: ซ่อน BG สีฟ้า (isCurrentPeriod highlight) สำหรับสัญญาสถานะ ระงับสัญญา / สิ้นสุดสัญญา / หนี้เสีย (ใน DebtReport.tsx)
- [x] P53-3: TypeScript check ผ่าน 0 errors
- [x] P53-4: Checkpoint + Push GitHub

### Phase 54 — ระงับสัญญา: งวดที่ชำระแล้วแสดงยอดปกติ
- [x] P54-1: แก้ isSuspended condition ใน listDebtTarget — เพิ่ม `&& paid <= 0` เพื่อให้งวดที่มีการชำระแล้วแสดงยอดปกติ
- [x] P54-2: แก้ isSuspended condition ใน listDebtTargetStream — เช่นเดียวกัน
- [x] P54-3: TypeScript check ผ่าน 0 errors
- [x] P54-4: อัปเดต skill + Checkpoint + Push GitHub

### Phase 55 — หนี้เสีย: ใช้ badDebtPeriod เป็นจุดตัด isSuspended
- [x] P55-1: คำนวณ badDebtFromPeriod จาก lastNormalPeriod+1 ใน listDebtTarget (Pass 1 ก่อน build installments)
- [x] P55-2: แก้ isSuspended สำหรับ isContractBadDebt ให้ใช้ badDebtFromPeriod แทน suspendedFromPeriod
- [x] P55-3: ทำเช่นเดียวกันใน listDebtTargetStream
- [x] P55-4: TypeScript check ผ่าน 0 errors
- [x] P55-5: อัปเดต skill + Checkpoint + Push GitHub

### Phase 55b — แก้ bug badDebtPeriod คำนวณผิด (TXRT receipt pattern)
- [x] P55b-1: แก้ normalPayments filter ใน listDebtTarget ให้รวม TXRT receipt pattern ด้วย
- [x] P55b-2: แก้เช่นเดียวกันใน listDebtTargetStream
- [x] P55b-3: TypeScript check ผ่าน 0 errors
- [x] P55b-4: Checkpoint + Push GitHub

### Phase 62 — Fix: isClosed Logic 3 Patterns (เป้าเก็บหนี้)
3 Patterns:
- P1: maxNormal=0 (TXRTC ปิดงวดแรก) → งวด 1 ยอดปกติ, งวด 2+ ปิดค่างวด
- P2: 1 < maxNormal < totalPeriods (TXRTC ปิดงวด N ระหว่างกลาง) → งวด 1..N ยอดปกติ, งวด N+1+ ปิดค่างวด
- P3: maxNormal = totalPeriods (TXRTC ปิดงวดสุดท้ายงวดเดียว) → ทุกงวด ยอดปกติ
- [x] P62-1: แก้ไข closedByContract logic ใน listDebtTarget (non-stream) — Pass 2 ใช้ installCountByKey + sentinel -1 สำหรับ Pattern 3
- [x] P62-2: แก้ไข closedByContract logic ใน listDebtTargetStream — เช่นเดียวกัน (installCountByKeyStream)
- [x] P62-3: ทดสอบ 3 patterns จาก DB จริง — P1: 3 สัญญา, P2: 2 สัญญา, P3: 0 (ยังไม่มีใน DB), TypeScript 0 errors
- [x] P62-4: Commit + push GitHub + checkpoint

### Phase 63 — Fix: ยอดเก็บหนี้ (collected stream) แสดง carry rows สำหรับงวดที่ถูกหักด้วย overpaid pool
- [x] P63-1: วิเคราะห์โค้ด listDebtCollectedStream ว่าตอนนี้แสดง carry rows อย่างไร
- [x] P63-2: แก้ไข backend ให้สร้าง carry rows ใน collected stream (receipt=(carry), วันที่=วันที่ TXRT ที่ overpaid, amount=0, หมายเหตุ=(-หักชำระเกิน: X))
- [x] P63-3: แก้ไข frontend ให้แสดง carry rows ใน collected tab
- [x] P63-4: ทดสอบ ยืนยันผลลัพธ์ตรงกับภาพ
- [x] P63-5: Commit + push GitHub + checkpoint

### Phase 64 — Fix: เป้าเก็บหนี้ overpaid cascade ไม่ถูกต้อง (งวด 3,4 ควร = 0 พร้อม annotation)
- [x] P64-1: ตรวจสอบ listDebtTarget overpaid cascade logic สำหรับ CT0925-PKN001-15462-01
- [x] P64-2: แก้ไข listDebtTarget และ listDebtTargetStream ให้ overpaid cascade ถูกต้อง
- [x] P64-3: Restart server + ทดสอบผลลัพธ์
- [x] P64-4: Commit + push GitHub + checkpoint

### Phase 65 — Fix: งวด 6,7,8 ของ CT0925-PKN001-15462-01 แสดงเป็น ปิดค่างวด ทั้งที่มี payment จริง
- [x] P65-1: ตรวจสอบ closedByContract logic สำหรับ CT0925-PKN001-15462-01
- [x] P65-2: แก้ไข isClosed logic ใน listDebtTarget และ listDebtTargetStream
- [x] P65-3: Restart server + ทดสอบผลลัพธ์
- [x] P65-4: Commit + push GitHub + checkpoint

### Phase 66 — Fix: ซ่อน BG สีฟ้าสำหรับสัญญาหนี้เสียในเป้าเก็บหนี้
- [x] P66-1: เพิ่ม 'หนี้เสีย' ใน isSpecialContractStatus เพื่อซ่อน BG สีฟ้า (current period highlight)
- [x] P66-2: Commit + push GitHub + checkpoint
### Phase 67 — Fix: เป้าเก็บหนี้ สัญญาหนี้เสีย (FF365) ที่ไม่มี installment_status_code ให้ใช้ max TXRT receipt suffix + 1 เป็น suspendedFromPeriod
- [x] P67-1: แก้ไข listDebtTarget — เพิ่ม fallback สำหรับ bad debt contract ที่ไม่มี installment_status_code: หา max TXRT suffix จาก payment_transactions แล้วใช้ max+1 เป็น suspendedFromPeriod
- [x] P67-2: แก้ไข listDebtTargetStream — เพิ่ม fallback เดียวกัน
- [x] P67-3: Restart server + ทดสอบ CT0126-AYA001-20952-01 (งวด 1-2 ปกติ, งวด 3-12 หนี้เสีย)
- [x] P67-4: Commit + push GitHub + checkpoint
### Phase 68 — Fix: suspendedFromPeriod ต้องข้าม TXRT ที่เป็น device sale payment (total ≈ bad_debt_amount)
- [x] P68-1: แก้ไข listDebtTarget — ใน normalPeriodsByContractOuter ให้ข้าม TXRT receipt ที่ total_paid_amount ≈ contractBadDebtAmount
- [x] P68-2: แก้ไข listDebtTargetStream — เพิ่ม logic เดียวกัน
- [x] P68-3: Restart server + ทดสอบ CT0126-AYA001-20952-01 (งวด 1 ปกติ, งวด 2-12 หนี้เสีย)
- [x] P68-4: Commit + push GitHub + checkpoint

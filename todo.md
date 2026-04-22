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
- [ ] Logic หนี้เสีย: แสดงยอดขายซากที่งวดล่าสุด (แยกออกจาก Phase 9e — ยังไม่มีเคสหนี้เสียใน DB ปัจจุบัน — defer ไว้จนกว่ามีข้อมูล)
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
- [ ] Test (b): เพิ่ม targeted test สำหรับ contract ที่มี overpaid carry (เช่น ext=1496 หรือ 1517): งวดถัดไปต้อง amount < baseline, overpaidApplied > 0
- [ ] Commit + push + save checkpoint

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

# Report System

ระบบ Report System สำหรับจัดการข้อมูลสัญญาและรายงานหนี้ โดยดึงข้อมูลจาก API ของ
**Boonphone** (`partner.boonphone.co.th`) และ **Fastfone365** (`partner.fastfone365.co.th`)
พัฒนาด้วย **React 19 + TypeScript + tRPC 11 + Drizzle ORM + MySQL (TiDB)** ใช้ Tailwind 4 + shadcn/ui
และออกแบบหน้าจอแบบ Mobile-First เพื่อดูรายงานผ่านสมาร์ทโฟนได้สะดวก

> GitHub: https://github.com/tool-boonphone/Report-System

---

## 1. สถาปัตยกรรม

```
client/        React 19 + Vite + Tailwind 4 + shadcn/ui
  src/
    pages/      Login, SelectSection, Contracts, DebtReport, ChangePassword, settings/*
    components/ TopNav, AppShell, SyncStatusBar, DashboardLayout (legacy)
    contexts/   SectionContext (Boonphone/Fastfone365), NavActionsContext, ThemeContext
    hooks/      useAppAuth (session + permissions)
server/        Express + tRPC 11
  api/          Partner API client (login + token cache + retry) + mappers
  sync/         Runner + scheduler (cron 08:00–19:00 Mon–Sat) + cross-process lock
  routers/      auth, admin, contracts, debt, sync
  authDb.ts     Custom session + bcrypt + permission matrix
  contractsDb.ts / debtDb.ts  Query helpers
  _core/*       OAuth (unused by this app) + framework glue
drizzle/       Schema + migrations
shared/        Constants shared between client and server (SECTIONS, CONTRACT_COLUMNS, …)
```

**สถานะการส่งมอบ** (จาก `todo.md`):

| Phase | Feature | สถานะ |
|------|---------|-------|
| 1 | Design System + DB Schema + Seed Super Admin | ✅ |
| 2 | Auth ภายใน + จัดการผู้ใช้ + จัดการกลุ่มสิทธิ์ + Logout | ✅ |
| 3 | API Sync Engine (Boonphone) + Scheduler + Manual Sync + Toast | ✅ |
| 3 | API Sync Engine (Fastfone365) | ⏸️ รอ credentials ที่ถูกต้อง (401) |
| 4 | ตาราง 41 คอลัมน์ + Filter/Search/Sort/Pagination + Export Excel | ✅ |
| 5 | รายงานหนี้ (เป้า vs เก็บ) + Top Overdue + Export Excel | ✅ |
| 6 | GitHub + Tests + README + Delivery | ✅ |

---

## 2. การตั้งค่า Environment

ระบบใช้ Environment Variables ทั้งหมด — ห้าม hard-code credentials ในโค้ด

```
# Database
DATABASE_URL            mysql://user:pass@host:port/db

# Auth
JWT_SECRET              ใช้เซ็น session cookie

# Boonphone API
BOONPHONE_API_URL       https://partner.boonphone.co.th/
BOONPHONE_API_USERNAME  (ส่งให้ผ่าน Secrets UI)
BOONPHONE_API_PASSWORD  (ส่งให้ผ่าน Secrets UI)

# Fastfone365 API
FASTFONE_API_URL        https://partner.fastfone365.co.th/
FASTFONE_API_USERNAME   (รอ credentials ที่ถูกต้อง)
FASTFONE_API_PASSWORD   (รอ credentials ที่ถูกต้อง)
```

เมื่อได้ credentials ที่ถูกต้องของ Fastfone365 ให้อัปเดตที่
`Settings → Secrets` ในหน้าจัดการโปรเจค ระบบจะเริ่ม sync ให้อัตโนมัติใน cron รอบถัดไป

---

## 3. Default Super Admin

```
Username : Sadmin
Password : Aa123456+
```

บัญชีนี้ถูก seed อัตโนมัติเมื่อ server เริ่มทำงาน (`server/authDb.ts → seedSuperAdmin`)
โปรด **เปลี่ยนรหัสผ่าน** ทันทีในหน้า "เปลี่ยนรหัสผ่าน" หลัง login ครั้งแรก

### สิทธิ์ (Permission Matrix)
แต่ละกลุ่มสามารถเปิด/ปิดสิทธิ์ได้ 6 ด้าน × 4 เมนู (เมนูตั้งค่า, ข้อมูลสัญญา, รายงานหนี้, …):
`view / add / edit / delete / approve / export`

กลุ่ม `Super Admin` จะผ่านเสมอ (bypass permission matrix) และเป็นกลุ่มเดียวที่
เข้าถึงเมนู **จัดการผู้ใช้งาน / จัดการสิทธิ์** ได้

---

## 4. Sync Engine

- **Scheduler**: รันทุก 1 ชั่วโมง ระหว่าง 08:00–19:00 จันทร์–เสาร์ (เวลา server)
- **Missed-sync**: ตอน server boot หาก last success เกิน 1 ชั่วโมง จะสั่งรอบแรกทันที
- **Cool-off**: ถ้า sync ล่าสุดเป็น error ภายใน 1 ชั่วโมงที่ผ่านมา จะข้าม section นั้น
- **Manual Sync**: กดปุ่ม "Refresh" ที่ TopNav → ทำงาน background + toast แจ้งเตือน
- **Lock**: ใช้ `sync_logs` ใน MySQL เป็น cross-process lock (เช็ค `entity='all'` + `in_progress`) ร่วมกับ in-memory lock ใน process เดียว
- **Retry**: per-request retry 3 ครั้ง + exponential backoff (1s / 3s / 9s) ใน `PartnerClient.get()`
- **Timeout**: 30 นาที/section (Promise.race)

เอนทิตีที่ sync: `partners → customers → contracts → installments → payment_transactions`

---

## 5. ข้อมูลสัญญา (41 คอลัมน์)

ลำดับคอลัมน์ตรงตามไฟล์ `Ex-Super_Report.xls` ที่ลูกค้าให้มา กำหนดไว้ใน
`shared/const.ts → CONTRACT_COLUMNS` ซึ่งทั้งหน้าเว็บและไฟล์ Excel ใช้แหล่งเดียวกัน

ฟีเจอร์:
- Search: เลขสัญญา / ลูกค้า / พาร์ทเนอร์ / โทร / IMEI / Serial / บัตร ปชช.
- Filter: สถานะ / ประเภทหนี้ / รหัสพาร์ทเนอร์ / ช่วงวันที่ (ยื่น/อนุมัติ)
- Sort: เลขสัญญา, วันยื่น, วันอนุมัติ, สถานะ, ลูกค้า, พาร์ทเนอร์
- Pagination: 50 แถว/หน้า
- Export: `/api/export/contracts?section=...&...` (stream XLSX ด้วย ExcelJS)

---

## 6. รายงานหนี้

- **เป้าเก็บหนี้** = `SUM(installments.amount)` ที่ `due_date` อยู่ในช่วงที่เลือก
- **ยอดเก็บหนี้** = `SUM(payment_transactions.amount)` ที่ `paid_at` อยู่ในช่วง และ
  `status ∈ { active, paid, success, completed }` (case-insensitive)
- แสดง Summary + รายเดือน + **Top Overdue List** (สัญญาที่ค้างชำระสะสมสูงสุด)
- Export: `/api/export/debt?section=...&from=YYYY-MM-DD&to=YYYY-MM-DD`

---

## 7. คำสั่งสำหรับนักพัฒนา

```bash
pnpm install           # ติดตั้ง dependencies
pnpm dev               # รัน dev server (Vite + tsx watch)
pnpm check             # TypeScript strict check
pnpm test              # รัน Vitest (20 passed, 1 skipped)
pnpm drizzle-kit generate   # สร้าง migration หลังแก้ schema
```

---

## 8. การทำงานกับ GitHub (สำหรับมือใหม่)

Repository: https://github.com/tool-boonphone/Report-System

```bash
# ครั้งแรก: clone โปรเจคลงเครื่อง
gh repo clone tool-boonphone/Report-System
cd Report-System

# เมื่อแก้ไขโค้ดเสร็จ → commit & push
git add .
git commit -m "Fix: ... / Add: ... / Update: ..."
git push origin main

# ก่อนเริ่มงานทุกครั้ง → ดึงโค้ดล่าสุด
git pull origin main
```

ทุก commit ใช้ภาษาอังกฤษสั้น ๆ ขึ้นต้นด้วย `Add:`, `Fix:`, `Update:`, `Refactor:`
เพื่อให้ง่ายต่อการอ่านประวัติ

---

## 9. แผนงานต่อ (ถ้ามี)

- [ ] เติม credentials Fastfone365 ที่ถูกต้อง → เปิด test `Fastfone365 login returns a token` กลับ
- [ ] เพิ่มหน้า "ประวัติการ Sync" ในเมนูตั้งค่า (แสดง `sync_logs`)
- [ ] แดชบอร์ด KPI รวม (เป้า/เก็บ/Gap) เป็นกราฟแท่งเทียบเดือน
- [ ] บันทึกรายชื่อผู้ใช้ที่ trigger manual sync ลง `sync_logs.triggered_by_user`

---
_สร้าง/อัปเดตครั้งล่าสุดโดย Manus Agent — ดูเวอร์ชันและรายละเอียดงานเพิ่มเติมที่ `todo.md`_

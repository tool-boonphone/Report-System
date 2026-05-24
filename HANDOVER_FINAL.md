# Boonphone Report System - Final Technical Handover Document

เอกสารฉบับนี้เป็นเอกสารสรุปรายละเอียดทางเทคนิคขั้นสุดท้าย รวบรวมข้อมูลสเปคระบบ, การเชื่อมต่อ, สถาปัตยกรรม API, และแนวทางการดูแลรักษา สำหรับระบบรายงาน Boonphone และ Fastfone365

---

## 1. ข้อมูลบัญชีและการเข้าถึง (Accounts & Access)

### 1.1 โครงสร้างพื้นฐาน (Infrastructure)
- **GitHub / Render Account**: `tool.boonphone@gmail.com`
- **Password**: `@Boonphone2025`
- **Repository**: [https://github.com/tool-boonphone/Report-System](https://github.com/tool-boonphone/Report-System)
- **Deployment**: Render (Web Service + Managed PostgreSQL)

### 1.2 ระบบความปลอดภัย (Security)
- **Default Admin**: Username: `Sadmin` / Password: `Aa123456+`
- **JWT Secret**: ระบุใน Environment Variable `JWT_SECRET` สำหรับจัดการ Session

---

## 2. รายละเอียดเมนูและการใช้งาน (System Modules)

### 2.1 รายงานสัญญาและหนี้ (Contract & Debt Management)
- **ข้อมูลสัญญา (Contract)**: รายการสัญญาพร้อมสถานะเชิงลึก (41 คอลัมน์มาตรฐาน)
- **รายงานหนี้ (Debt Report)**: วิเคราะห์สถานะหนี้ตามช่วงเวลา
- **หนี้สงสัยจะเสีย (Suspected Bad Debt)**: ระบบคัดกรองสัญญาที่มีความเสี่ยง
- **สรุปหนี้เสีย (Bad Debt Summary)**: สรุปความเสียหายจากหนี้เสีย
- **สรุปรายเดือน (Monthly Summary)**: ภาพรวมผลการดำเนินงานรายเดือน

### 2.2 ระบบบัญชี (Accounting)
- **รายรับ (Income)**: สรุปเงินโอนเข้า แบ่งประเภทเป็น "ค่างวด", "ปิดยอด", และ "ขายเครื่อง"
- **รายจ่าย (Expense)**: สรุปยอดจ่ายพาร์ทเนอร์ สูตร: `Finance + Commission + Incentive`

---

## 3. รายละเอียดการเชื่อมต่อ API (Partner API Integration)

ระบบเชื่อมต่อกับ Partner API สองแห่งเพื่อดึงข้อมูลมาประมวลผล:

### 3.1 ข้อมูลการเชื่อมต่อ (Credentials)
| Section | Base API URL | Username | Password |
| :--- | :--- | :--- | :--- |
| **Boonphone** | `BOONPHONE_API_URL` | `BOONPHONE_USERNAME` | `BOONPHONE_PASSWORD` |
| **Fastfone365** | `FASTFONE_API_URL` | `FASTFONE_USERNAME` | `FASTFONE_PASSWORD` |

### 3.2 Endpoints สำคัญ (Partner API v1)
ทุก Endpoint จะต้องผ่านการ Login ที่ `/api/v1/auth/login` เพื่อรับ Bearer Token
- **Contracts**: `GET /api/v1/contracts`
- **Installments**: `GET /api/v1/installments`
- **Payments**: `GET /api/v1/payments`
- **Commissions**: `GET /api/v1/commissions`

### 3.3 สถาปัตยกรรม API ภายใน (Internal API)
- **tRPC**: ใช้สื่อสารระหว่าง Frontend/Backend แบบ Type-safe (Path: `/server/routers/`)
- **REST Streaming**: ใช้สำหรับ Export ข้อมูลขนาดใหญ่เพื่อป้องกัน Memory Crash
  - `/api/export/contracts`
  - `/api/export/income`
  - `/api/export/expense`

---

## 4. ระบบฐานข้อมูล (Database Architecture)

ระบบใช้ PostgreSQL โดยแยกฐานข้อมูลตาม Section เพื่อความปลอดภัยและประสิทธิภาพ:

| Section | Database Variable | บทบาท |
| :--- | :--- | :--- |
| **Boonphone** | `BOONPHONE_DATABASE_URL` | ข้อมูล Boonphone + ฐานข้อมูล Auth (Users/Permissions) |
| **Fastfone365** | `FASTFONE_DATABASE_URL` | ข้อมูล Fastfone365 เท่านั้น |

---

## 5. ระบบอัตโนมัติ (Automation & Sync)

- **Daily Sync**: รันอัตโนมัติทุกวันเวลา **01:00 น. (Asia/Bangkok)**
- **Sync Stages**: Partners → Customers → Contracts → IMEI → Installments → Payments → Commissions → Bad Debt → Cache
- **Keep-alive**: ระบบ Self-ping ทุก 10 นาที เพื่อป้องกัน Render Instance หลับระหว่างซิงค์ข้อมูล
- **Manual Sync**: สามารถสั่งรันซิงค์ด้วยมือได้ผ่านเมนู "Re-Sync API" ในระบบ

---

## 6. ข้อควรระวังและเทคนิคการดูแลรักษา (Maintenance & Concerns)

- **⚠️ Shared Auth**: หาก DB Boonphone มีปัญหา จะไม่สามารถ Login เข้าใช้งานได้ทุก Section
- **⚠️ Sync Logs**: หากการซิงค์ค้างหรือ Error สามารถตรวจสอบรายละเอียดได้ที่ตาราง `sync_logs`
- **🛠 Schema Update**: หากแก้ไข DB Schema ต้องรัน `pnpm db:push` เพื่ออัปเดตผ่าน Drizzle Kit
- **🛠 Timezone**: ตรวจสอบให้แน่ใจว่า Server ตั้งค่าเป็น **Asia/Bangkok** เพื่อความถูกต้องของรายงาน

---

## 7. รายการไฟล์ที่สำคัญ (Key File References)
- `/server/db.ts`: การจัดการ DB และ Connection Pool
- `/server/accountingDb.ts`: Logic รายงานบัญชี
- `/server/sync/runner.ts`: ระบบ Sync หลัก
- `/shared/const.ts`: ค่าคงที่และโครงสร้างคอลัมน์รายงาน

---
*เอกสารฉบับสมบูรณ์ จัดทำเมื่อวันที่ 25 พฤษภาคม 2026*

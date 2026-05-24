# Boonphone Report System - Technical Handover Document

เอกสารฉบับนี้สรุปรายละเอียดทางเทคนิค สเปคของระบบ และข้อมูลที่จำเป็นสำหรับการดูแลรักษาหรือพัฒนาต่อยอดระบบรายงาน Boonphone และ Fastfone365

---

## 1. ภาพรวมระบบ (System Overview)
ระบบนี้ทำหน้าที่รวบรวมข้อมูลจาก Partner API (Boonphone และ Fastfone365) มาประมวลผลและแสดงผลในรูปแบบรายงานทางบัญชี (รายรับ/รายจ่าย) และรายงานสถานะสัญญาต่างๆ โดยมีการแยกข้อมูลตาม **Section** อย่างชัดเจน

### เทคโนโลยีที่ใช้ (Tech Stack)
- **Frontend**: React, TypeScript, Vite, TailwindCSS, Lucide React, Shadcn UI
- **Backend**: Node.js, TypeScript, Express, tRPC
- **Database**: PostgreSQL (Managed on Render), Drizzle ORM
- **Automation**: In-process Scheduler (node-cron)

---

## 2. ข้อมูลการเชื่อมต่อ (Connectivity & Credentials)

ระบบใช้ Environment Variables ในการจัดการการเชื่อมต่อทั้งหมด โดยแบ่งตาม Section ดังนี้:

### ฐานข้อมูล (Database Connections)
| Section | Environment Variable | หมายเหตุ |
| :--- | :--- | :--- |
| **Boonphone** | `BOONPHONE_DATABASE_URL` | ใช้เก็บข้อมูล Boonphone และเป็น Auth DB หลัก |
| **Fastfone365** | `FASTFONE_DATABASE_URL` | ใช้เก็บข้อมูล Fastfone365 เท่านั้น |
| **Fallback** | `DATABASE_URL` | ใช้เมื่อไม่พบตัวแปรเฉพาะ Section |

### Partner API Credentials
| Section | API URL Variable | Username Variable | Password Variable |
| :--- | :--- | :--- | :--- |
| **Boonphone** | `BOONPHONE_API_URL` | `BOONPHONE_USERNAME` | `BOONPHONE_PASSWORD` |
| **Fastfone365** | `FASTFONE_API_URL` | `FASTFONE_USERNAME` | `FASTFONE_PASSWORD` |

### ระบบความปลอดภัย (Security & Auth)
- `JWT_SECRET`: ใช้สำหรับลงนาม Session Cookie
- `APP_SESSION_COOKIE`: ชื่อคุกกี้เซสชัน (เริ่มต้น: `report_session`)
- **Default Admin**: Username: `Sadmin` / Password: `Aa123456+` (ถูก Seed อัตโนมัติหากไม่มีในระบบ)

---

## 3. สถาปัตยกรรมและการทำงานที่สำคัญ (Core Architecture)

### ระบบการซิงค์ข้อมูล (Sync Engine)
- **Scheduler**: ทำงานอัตโนมัติทุกวันเวลา **01:00 น. (Asia/Bangkok)**
- **Pipeline**: เริ่มจากดึง Partners → Customers → Contracts → IMEI → Installments → Payments → Commissions → Bad Debt → Rebuild Cache
- **Resilience**: มีระบบ Lock ป้องกันการรันซ้ำซ้อน และระบบ Keep-alive (Self-ping) เพื่อป้องกัน Instance หลับระหว่างประมวลผล

### การคำนวณที่สำคัญ (Key Logic)
- **Total Transfer (รวมยอดโอน)**: ในหน้า Expense (รายจ่าย) คำนวณจาก `Finance Amount + Commission + Incentive`
- **Income Classification**: มีการแบ่งประเภทรายรับเป็น "ค่างวด", "ปิดยอด", และ "ขายเครื่อง" (สำหรับหนี้เสีย) โดยใช้ Logic 2 ระดับ (Paid Date และ Created Date)
- **Cache System**: ใช้ตาราง `income_monthly_summary` เพื่อเพิ่มความเร็วในการโหลดรายงานสรุปรายเดือน/รายปี

---

## 4. สิ่งที่ควรระวัง (Concerns & Critical Notes)

> **[ข้อควรระวัง] การจัดการฐานข้อมูล**
> - ปัจจุบันระบบแยกฐานข้อมูลระหว่าง Boonphone และ Fastfone365 อย่างเด็ดขาด แต่ **Auth DB (ผู้ใช้งาน/สิทธิ์)** จะถูกเก็บไว้ที่ฐานข้อมูลของ **Boonphone** เท่านั้น ดังนั้นหากฐานข้อมูล Boonphone มีปัญหา จะส่งผลต่อการ Login ทั้งระบบ

> **[ข้อควรระวัง] ประสิทธิภาพการ Query**
> - ข้อมูลในตาราง `payment_transactions` มีปริมาณมาก การ Query แบบ Live SQL อาจทำให้เกิด Timeout ได้ จึงควรใช้ระบบ **Fast Path** (ดึงจากคอลัมน์ `income_type` ที่ถูก Populate ไว้แล้ว) หรือดึงจาก **Monthly Cache** เสมอ

> **[ข้อควรระวัง] สภาพแวดล้อม (Timezone)**
> - ระบบยึดเวลา **Asia/Bangkok (UTC+7)** เป็นหลักในการทำงานของ Scheduler และการสรุปยอดรายงาน หากย้าย Server ต้องตรวจสอบการตั้งค่า Timezone ให้ถูกต้อง

---

## 5. รายการไฟล์สำคัญ (Key File References)
- `/server/db.ts`: การจัดการ Connection Pool และการแยก DB ตาม Section
- `/server/accountingDb.ts`: Backend logic สำหรับรายงานรายรับ/รายจ่าย
- `/server/sync/runner.ts`: ตัวขับเคลื่อนหลักของระบบ Sync
- `/server/sync/scheduler.ts`: การตั้งค่าเวลาทำงานอัตโนมัติ
- `/client/src/pages/Expense.tsx`: Frontend สำหรับหน้ารายจ่ายและการคำนวณหน้าบ้าน

---
*เอกสารนี้จัดทำขึ้นเมื่อวันที่ 25 พฤษภาคม 2026*

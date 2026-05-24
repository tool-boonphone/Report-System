# Boonphone Report System - Technical Handover Document

เอกสารฉบับนี้สรุปรายละเอียดทางเทคนิค สเปคของระบบ และข้อมูลที่จำเป็นสำหรับการดูแลรักษาหรือพัฒนาต่อยอดระบบรายงาน Boonphone และ Fastfone365

---

## 1. ข้อมูลบัญชีและการเข้าถึง (Accounts & Access)

- **GitHub / Render Account**: `tool.boonphone@gmail.com`
- **Password Reference**: `@Boonphone2025`
- **Repository**: [https://github.com/tool-boonphone/Report-System](https://github.com/tool-boonphone/Report-System)
- **Deployment Platform**: Render (Web Service + PostgreSQL)

---

## 2. ภาพรวมระบบ (System Overview)
ระบบนี้ทำหน้าที่รวบรวมข้อมูลจาก Partner API (Boonphone และ Fastfone365) มาประมวลผลและแสดงผลในรูปแบบรายงานทางบัญชี (รายรับ/รายจ่าย) และรายงานสถานะสัญญาต่างๆ โดยมีการแยกข้อมูลตาม **Section** อย่างชัดเจน

### เทคโนโลยีที่ใช้ (Tech Stack)
- **Frontend**: React, TypeScript, Vite, TailwindCSS, Shadcn UI
- **Backend**: Node.js, TypeScript, Express, tRPC (Type-safe API)
- **Database**: PostgreSQL (Managed on Render), Drizzle ORM
- **Automation**: In-process Scheduler (node-cron) รันภายในตัวแอป

---

## 3. ข้อมูลการเชื่อมต่อ (Connectivity & Credentials)

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

## 4. สถาปัตยกรรมและการทำงานที่สำคัญ (Core Architecture)

### ระบบการซิงค์ข้อมูล (Sync Engine)
- **Scheduler**: ทำงานอัตโนมัติทุกวันเวลา **01:00 น. (Asia/Bangkok)**
- **Sync Stages**: Partners → Customers → Contracts → IMEI → Installments → Payments → Commissions → Bad Debt → Cache
- **Keep-alive**: มีระบบ Self-ping ทุก 10 นาที เพื่อป้องกัน Render Instance หลับ (Spin down) ระหว่างที่กำลังซิงค์ข้อมูลขนาดใหญ่

### การคำนวณที่สำคัญ (Key Logic)
- **Total Transfer (รวมยอดโอน)**: ในหน้า Expense (รายจ่าย) คำนวณจาก `Finance Amount + Commission + Incentive`
- **Income Classification**: แบ่งประเภทรายรับเป็น "ค่างวด", "ปิดยอด", และ "ขายเครื่อง" (สำหรับหนี้เสีย) โดยใช้ Logic 2 ระดับ (Paid Date และ Created Date)
- **Cache System**: ใช้ตาราง `income_monthly_summary` เพื่อเพิ่มความเร็วในการโหลดรายงานสรุปรายเดือน/รายปี

---

## 5. สิ่งที่ควรระวังและคำแนะนำ (Critical Notes & Advice)

### ⚠️ จุดเปราะบาง (Critical Concerns)
- **Shared Auth DB**: ข้อมูลผู้ใช้งานและสิทธิ์ทั้งหมดถูกเก็บไว้ที่ DB ของ **Boonphone** เท่านั้น หาก DB นี้ล่ม จะไม่สามารถ Login เข้าใช้งาน Section อื่นได้
- **Sync Timeout**: การซิงค์ข้อมูลปริมาณมากอาจใช้เวลานาน (เกิน 1 ชม.) หากเกิด Error กลางคัน ระบบมีกลไก `clearAllStuckSyncLogs` ตอน Startup เพื่อล้างสถานะที่ค้างอยู่
- **Database Migration**: หากมีการเปลี่ยน Database URL บน Render ต้องอัปเดตทั้งใน Env และตรวจสอบว่า Firewall/Access Control ยอมรับการเชื่อมต่อจากภายนอก (ถ้ามี)

### 🛠 การ Debug และบำรุงรักษา
- **Manual Sync**: สามารถสั่งรันซิงค์ด้วยมือได้ผ่านหน้า UI (เมนู Re-Sync API) หากต้องการอัปเดตข้อมูลทันที
- **Logs**: ตรวจสอบ Log การซิงค์ได้จากตาราง `sync_logs` ในฐานข้อมูล เพื่อดูว่า Stage ไหนที่เกิด Error
- **Database Schema**: หากมีการแก้ไขโครงสร้าง DB ต้องรัน `pnpm db:push` เพื่ออัปเดต Schema ผ่าน Drizzle Kit

---

## 6. รายการไฟล์สำคัญ (Key File References)
- `/server/db.ts`: การจัดการ Connection Pool และการแยก DB ตาม Section
- `/server/accountingDb.ts`: Backend logic สำหรับรายงานรายรับ/รายจ่าย
- `/server/sync/runner.ts`: ตัวขับเคลื่อนหลักของระบบ Sync
- `/server/sync/scheduler.ts`: การตั้งค่าเวลาทำงานอัตโนมัติ
- `/client/src/pages/Expense.tsx`: Frontend สำหรับหน้ารายจ่ายและการคำนวณหน้าบ้าน

---
*เอกสารนี้จัดทำขึ้นเมื่อวันที่ 25 พฤษภาคม 2026*

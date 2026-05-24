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
- **รายงานหนี้ (Debt Report)**: วิเคราะห์สถานะหนี้ตามช่วงเวลา (เป้าเก็บหนี้ vs ยอดเก็บหนี้)
- **หนี้สงสัยจะเสีย (Suspected Bad Debt)**: ระบบคัดกรองสัญญาที่มีความเสี่ยงตามเงื่อนไข
- **สรุปหนี้เสีย (Bad Debt Summary)**: สรุปยอดความเสียหายและสถานะหนี้เสีย
- **สรุปรายเดือน (Monthly Summary)**: ภาพรวมการอนุมัติและยอดจัดรายเดือน

### 2.2 ระบบบัญชี (Accounting)
- **รายรับ (Income)**: สรุปเงินโอนเข้า แบ่งประเภทเป็น "ค่างวด", "ปิดยอด", และ "ขายเครื่อง"
- **รายจ่าย (Expense)**: สรุปยอดจ่ายพาร์ทเนอร์ สูตร: `รวมยอดโอน = Finance + Commission + Incentive`

---

## 3. รายละเอียดการเชื่อมต่อ Partner API

ระบบเชื่อมต่อกับ Partner API เพื่อดึงข้อมูลมาประมวลผล โดยมีรายละเอียดดังนี้:

### 3.1 ข้อมูลการเชื่อมต่อ (Credentials)
| Section | Base API URL | API Doc Link | Username | Password |
| :--- | :--- | :--- | :--- | :--- |
| **Boonphone** | `https://partner.boonphone.co.th/` | [Boonphone API Doc](https://partner.boonphone.co.th/docs) | `boonphone_api` | `bp@2025#access` |
| **Fastfone365** | `https://partner.fastfone365.co.th/` | [Fastfone API Doc](https://partner.fastfone365.co.th/docs) | `fastfone_api` | `ff@2025#access` |

*หมายเหตุ: Credentials ด้านบนเป็นค่าสำหรับระบบ API เท่านั้น หากมีการเปลี่ยนแปลงต้องอัปเดตที่ Environment Variables ของ Render*

### 3.2 Endpoints สำคัญ (API v1)
- **Auth**: `POST /api/v1/auth/login` (เพื่อรับ Bearer Token)
- **Contracts**: `GET /api/v1/contracts` (รายการสัญญา)
- **Installments**: `GET /api/v1/installments` (ตารางผ่อนชำระ)
- **Payments**: `GET /api/v1/payments` (ประวัติการชำระเงิน)
- **Commissions**: `GET /api/v1/commissions` (ค่าตอบแทนพาร์ทเนอร์)

---

## 4. สถาปัตยกรรมระบบ (System Architecture)

### 4.1 API ภายใน (Internal API)
- **tRPC**: ใช้สื่อสารระหว่าง Frontend/Backend แบบ Type-safe (Router อยู่ที่ `/server/routers/`)
- **REST Streaming**: ใช้สำหรับ Export ข้อมูล XLSX ขนาดใหญ่ เพื่อป้องกัน Memory Crash

### 4.2 ฐานข้อมูล (Database)
แยกฐานข้อมูลตาม Section บน Render:
- **Boonphone DB**: ข้อมูล Boonphone + **Auth DB** (ตาราง `users`, `app_groups`, `app_sessions`)
- **Fastfone365 DB**: ข้อมูล Fastfone365 เท่านั้น

---

## 5. ระบบอัตโนมัติและการซิงค์ (Automation & Sync)

- **Daily Sync**: รันอัตโนมัติทุกวันเวลา **01:00 น. (Asia/Bangkok)**
- **Keep-alive**: ระบบ Self-ping ทุก 10 นาที เพื่อป้องกัน Render Instance หลับระหว่างซิงค์
- **Manual Sync**: สั่งรันได้ผ่านปุ่ม "Refresh" หรือเมนู "Re-Sync API"
- **Resume Sync**: ระบบรองรับการ Resume จากหน้าที่ค้างไว้หากการซิงค์หยุดชะงัก

---

## 6. ข้อควรระวังและเทคนิคการดูแลรักษา (Maintenance & Concerns)

- **⚠️ Shared Auth**: สิทธิ์การใช้งานทั้งหมดผูกกับฐานข้อมูลของ Boonphone หาก DB นี้มีปัญหาจะ Login ไม่ได้
- **⚠️ Sync Timeout**: Partner API มี Timeout ที่ 20-30 วินาที ระบบมีการ Retry อัตโนมัติ 3 ครั้ง
- **🛠 Schema Update**: หากแก้ไข DB Schema ต้องรัน `pnpm db:push`
- **🛠 Export Large Data**: รายงานหนี้และสัญญาที่มีข้อมูลหลักหมื่นแถว ให้ใช้ปุ่ม Export Excel แทนการดูบนหน้าเว็บเพื่อประสิทธิภาพที่ดีกว่า

---

## 7. รายการไฟล์ที่สำคัญ (Key File References)
- `/server/db.ts`: การจัดการ Connection Pool และการแยก DB
- `/server/accountingDb.ts`: Logic คำนวณรายรับ/รายจ่าย (รวมสูตร Total Transfer)
- `/server/sync/runner.ts`: ตัวขับเคลื่อนหลักของระบบ Sync Engine
- `/shared/const.ts`: แหล่งรวมค่าคงที่และโครงสร้างคอลัมน์รายงานทั้งหมด

---
*เอกสารฉบับสมบูรณ์ (Final Version) จัดทำเมื่อวันที่ 25 พฤษภาคม 2026*

# Boonphone Report System - Technical Handover Document

เอกสารฉบับนี้สรุปรายละเอียดทางเทคนิค สเปคของระบบ และข้อมูลที่จำเป็นสำหรับการดูแลรักษาหรือพัฒนาต่อยอดระบบรายงาน Boonphone และ Fastfone365

---

## 1. ข้อมูลบัญชีและการเข้าถึง (Accounts & Access)

- **GitHub / Render Account**: `tool.boonphone@gmail.com`
- **Password Reference**: `@Boonphone2025`
- **Repository**: [https://github.com/tool-boonphone/Report-System](https://github.com/tool-boonphone/Report-System)
- **Deployment Platform**: Render (Web Service + PostgreSQL)

---

## 2. รายละเอียดเมนูและการใช้งาน (Menu & Functionality)

ระบบถูกออกแบบมาเพื่อจัดการและสรุปข้อมูลสัญญาจาก Partner โดยแบ่งเมนูหลักดังนี้:

### กลุ่มรายงานสัญญา (Contract Reports)
- **ข้อมูลสัญญา (Contract)**: รายการสัญญาทั้งหมด พร้อมสถานะและรายละเอียดเชิงลึก
- **รายงานหนี้ (Debt Report)**: วิเคราะห์สถานะหนี้ แบ่งตามประเภทและระยะเวลา
- **หนี้สงสัยจะเสีย (Suspected Bad Debt)**: สัญญาที่มีแนวโน้มจะเป็นหนี้เสีย
- **สรุปหนี้เสีย (Bad Debt Summary)**: สรุปยอดความเสียหายจากหนี้เสีย
- **สรุปรายเดือน (Monthly Summary)**: ภาพรวมการอนุมัติสัญญาและยอดจัดรายเดือน

### กลุ่มบัญชี (Accounting)
- **รายรับ (Income)**: สรุปยอดเงินโอนเข้า (ค่างวด, ปิดยอด, ขายเครื่อง)
- **รายจ่าย (Expense)**: สรุปยอดจ่ายค่าคอมมิชชั่นและ Incentive (Finance + Comm + Incentive)

---

## 3. สถาปัตยกรรม API (API Architecture)

ระบบใช้การสื่อสารผ่าน API สองรูปแบบหลัก:

### 3.1 tRPC (Internal API)
ใช้สำหรับการสื่อสารระหว่าง Frontend และ Backend แบบ Type-safe ทำให้เห็น Error ตั้งแต่ตอนเขียนโค้ด
- **Router Path**: อยู่ใน `/server/routers/`
- **Endpoints สำคัญ**:
  - `accounting`: จัดการข้อมูลรายรับ/รายจ่าย
  - `contracts`: จัดการข้อมูลสัญญาและรายงานหนี้
  - `sync`: จัดการสถานะและการสั่งรัน Sync
  - `auth`: จัดการการเข้าสู่ระบบและสิทธิ์ใช้งาน

### 3.2 REST API (Public/Specialized API)
ใช้สำหรับงานเฉพาะทางที่ tRPC ไม่รองรับ เช่น การ Streaming ข้อมูลขนาดใหญ่
- **Export**: `/api/export/contracts`, `/api/export/income`, `/api/export/expense` (รองรับการดาวน์โหลดไฟล์ Excel ขนาดใหญ่)
- **Sync Stream**: `/api/sync-stream/:section` (ใช้แสดง Progress การซิงค์แบบ Real-time)
- **Health Check**: `/api/ping` (ใช้สำหรับระบบ Keep-alive)

---

## 4. ระบบการ Export และการซิงค์ข้อมูล (Export & Sync)

- **Streaming Export**: ใช้เทคนิค Server-side Streaming เพื่อลดการใช้ Memory และรองรับข้อมูลปริมาณมาก
- **Automated Sync**: รันผ่าน Scheduler ทุกวันเวลา **01:00 น. (Asia/Bangkok)**
- **Self-ping**: ระบบส่งสัญญาณ Ping ตัวเองทุก 10 นาที เพื่อป้องกัน Render Instance หลับระหว่างประมวลผล

---

## 5. ข้อมูลการเชื่อมต่อ (Connectivity & Credentials)

### ฐานข้อมูล (Database Connections)
| Section | Environment Variable | หมายเหตุ |
| :--- | :--- | :--- |
| **Boonphone** | `BOONPHONE_DATABASE_URL` | ใช้เก็บข้อมูล Boonphone และเป็น Auth DB หลัก |
| **Fastfone365** | `FASTFONE_DATABASE_URL` | ใช้เก็บข้อมูล Fastfone365 เท่านั้น |

### Partner API Credentials
| Section | API URL Variable | Username Variable | Password Variable |
| :--- | :--- | :--- | :--- |
| **Boonphone** | `BOONPHONE_API_URL` | `BOONPHONE_USERNAME` | `BOONPHONE_PASSWORD` |
| **Fastfone365** | `FASTFONE_API_URL` | `FASTFONE_USERNAME` | `FASTFONE_PASSWORD` |

---

## 6. สิ่งที่ควรระวังและคำแนะนำ (Critical Notes & Advice)

- **Shared Auth DB**: สิทธิ์การใช้งานทั้งหมดผูกกับ DB ของ Boonphone
- **Database Schema**: หากแก้ไขโครงสร้าง DB ต้องรัน `pnpm db:push`
- **Timezone**: ระบบยึดเวลา **Asia/Bangkok (UTC+7)** เป็นหลัก
- **API Timeout**: Partner API มี Timeout ที่ 30 วินาที ระบบมีการจัดการ Retry อัตโนมัติ 3 ครั้ง

---

## 7. รายการไฟล์สำคัญ (Key File References)
- `/server/db.ts`: การจัดการ DB และ Connection Pool
- `/server/accountingDb.ts`: Logic รายงานรายรับ/รายจ่าย
- `/server/sync/runner.ts`: ระบบ Sync หลัก
- `/server/routers/`: โฟลเดอร์เก็บ tRPC Routers ทั้งหมด

---
*เอกสารนี้จัดทำขึ้นเมื่อวันที่ 25 พฤษภาคม 2026*

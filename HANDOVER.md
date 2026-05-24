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
- **ข้อมูลสัญญา (Contract)**: แสดงรายการสัญญาทั้งหมด พร้อมสถานะและรายละเอียดเชิงลึก
- **รายงานหนี้ (Debt Report)**: รายงานวิเคราะห์สถานะหนี้ แบ่งตามประเภทและระยะเวลา
- **หนี้สงสัยจะเสีย (Suspected Bad Debt)**: รายการสัญญาที่มีแนวโน้มจะเป็นหนี้เสียตามเงื่อนไขที่กำหนด
- **สรุปหนี้เสีย (Bad Debt Summary)**: รายงานสรุปยอดความเสียหายจากหนี้เสียในแต่ละช่วงเวลา
- **สรุปรายเดือน (Monthly Summary)**: มุมมองภาพรวมการอนุมัติสัญญาและยอดจัดในแต่ละเดือน

### กลุ่มบัญชี (Accounting)
- **รายรับ (Income)**: สรุปยอดเงินโอนเข้า แบ่งตามประเภท (ค่างวด, ปิดยอด, ขายเครื่อง) รองรับการดูแบบสรุปรายปี/รายเดือน และรายการรายบิล
- **รายจ่าย (Expense)**: สรุปยอดการจ่ายค่าคอมมิชชั่นและ Incentive ให้กับพาร์ทเนอร์ โดยใช้สูตรคำนวณ `รวมยอดโอน = Finance + Comm + Incentive`

### กลุ่มตั้งค่าและระบบ (System & Settings)
- **จัดการผู้ใช้งาน/สิทธิ์**: กำหนดสิทธิ์การเข้าถึงเมนูต่างๆ แยกตามกลุ่มผู้ใช้งาน
- **Re-Sync API**: เมนูสำหรับสั่งรันการดึงข้อมูลใหม่จาก Partner API ด้วยตนเอง (Manual Sync)

---

## 3. ระบบการ Export ข้อมูล (Export System)

ระบบรองรับการ Export ข้อมูลเป็นไฟล์ Excel (.xlsx) โดยมีรายละเอียดที่ควรทราบดังนี้:

- **Streaming Export**: สำหรับรายงานที่มีข้อมูลขนาดใหญ่ (เช่น รายงานหนี้ หรือ รายการรายรับ) ระบบใช้เทคนิค **Server-side Streaming** เพื่อทยอยส่งข้อมูลออกมา ทำให้ไม่เกิดปัญหา Memory เต็มบน Server และรองรับข้อมูลได้หลายหมื่นแถว
- **Custom Columns**: ในรายงานสัญญา (Contract Report) จะมีคอลัมน์มาตรฐาน 41 คอลัมน์ที่ถูกจัดเรียงตามลำดับที่ธุรกิจต้องการ (อ้างอิงไฟล์ `shared/const.ts`)
- **Excel Formatting**: ระบบมีการตั้งค่าความกว้างคอลัมน์และรูปแบบข้อมูล (Text/Number/Date/Money) ให้โดยอัตโนมัติเพื่อให้พร้อมใช้งานทันที

---

## 4. ข้อมูลการเชื่อมต่อ (Connectivity & Credentials)

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

## 5. สถาปัตยกรรมและการทำงานที่สำคัญ (Core Architecture)

### ระบบการซิงค์ข้อมูล (Sync Engine)
- **Scheduler**: ทำงานอัตโนมัติทุกวันเวลา **01:00 น. (Asia/Bangkok)**
- **Keep-alive**: มีระบบ Self-ping ทุก 10 นาที เพื่อป้องกัน Render Instance หลับระหว่างการซิงค์
- **Income Classification**: แบ่งประเภทรายรับเป็น "ค่างวด", "ปิดยอด", และ "ขายเครื่อง" (สำหรับหนี้เสีย) โดยใช้ Logic 2 ระดับ

---

## 6. สิ่งที่ควรระวังและคำแนะนำ (Critical Notes & Advice)

- **Shared Auth DB**: ข้อมูลผู้ใช้งานและสิทธิ์ทั้งหมดถูกเก็บไว้ที่ DB ของ **Boonphone** เท่านั้น
- **Sync Timeout**: การซิงค์ข้อมูลปริมาณมากอาจใช้เวลานาน ระบบมีกลไกเคลียร์สถานะที่ค้างอยู่ตอน Startup
- **Database Schema**: หากมีการแก้ไขโครงสร้าง DB ต้องรัน `pnpm db:push` เพื่ออัปเดต Schema
- **Memory Limit**: แม้จะใช้ Streaming Export แต่ควรระวังทรัพยากรบน Render หากมีการรัน Export พร้อมกันหลายคน

---

## 7. รายการไฟล์สำคัญ (Key File References)
- `/server/db.ts`: การจัดการ Connection Pool และการแยก DB ตาม Section
- `/server/accountingDb.ts`: Backend logic สำหรับรายงานรายรับ/รายจ่าย
- `/server/sync/runner.ts`: ตัวขับเคลื่อนหลักของระบบ Sync
- `/shared/const.ts`: แหล่งรวมค่าคงที่, รายชื่อเมนู และโครงสร้างคอลัมน์รายงาน

---
*เอกสารนี้จัดทำขึ้นเมื่อวันที่ 25 พฤษภาคม 2026*

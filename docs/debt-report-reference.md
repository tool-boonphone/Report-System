# Debt Report Reference (boonphone.co.th/mm.html)

## Controls (top bar)
- Title: "ระบบจำลองรายงานหนี้"
- Tabs: `🎯 เป้าเก็บหนี้` | `💰 ยอดเก็บหนี้`
- Status filter dropdown with options:
  - `-- ทุกสถานะหนี้ --`
  - `ปกติ`
  - `เกิน 1-7`
  - `เกิน 8-14`
  - `เกิน 15-30`
  - (more seen later: `เกิน 31-60`, `เกิน 61-90`, `เกิน >90`, `สิ้นสุดสัญญา`)
- Action: `ดาวน์โหลดไฟล์`

## Target tab (เป้าเก็บหนี้) — columns (left → right)
1. วันที่อนุมัติ
2. เลขที่สัญญา
3. ชื่อ-นามสกุล
4. เบอร์โทร
5. ยอดผ่อนรวม (sum of all installments)
6. งวดผ่อน (total installments count)
7. ผ่อนงวดละ (per-installment amount)
8. สถานะหนี้ (colored badge: `ระงับสัญญา` red, `เกิน 15-30` yellow, `เกิน >90` red, `เกิน 8-14` yellow, `ปกติ` green, `สิ้นสุดสัญญา` blue, `เกิน 31-60` red, `เกิน 61-90` red, `เกิน 1-7` yellow)
9. เกินกำหนด(...) — numeric
10. **Grouped "ข้อมูลชำระงวดที่ N" headers** that span installment cells per row:
    - งวดที่ | วันที่ต้องชำระ | เงินต้น | ดอกเบี้ย | ค่าติดตาม/เบี้ยปรับ …
    - Grouped header in blue, data area alternating color bands

Notes from screenshot:
- Row heights are compact with thin borders.
- Status badges use pill shape with colored backgrounds.
- The installment group repeats horizontally for each installment number.

## Installment group block (one repeating group per installment number)
Header (blue): `ข้อมูลชำระงวดที่ N`
Sub-columns under each group header (left → right):
- งวดที่
- วันที่ต้องชำระ
- เงินต้น
- ดอกเบี้ย
- ค่าดำเนินการ (aka ค่าติดตาม/เบี้ยปรับ depending on tab)
- ยอดหนี้รวม (shown only at the final installment per row — acts like row footer)

The group repeats for every installment number on the contract (1..N). For 36-งวด contracts there are 36 groups.

## Full status list (dropdown options)
ทุกสถานะหนี้ | ปกติ | เกิน 1-7 | เกิน 8-14 | เกิน 15-30 | เกิน 31-60 | เกิน 61-90 | เกิน >90 | ระงับสัญญา | สิ้นสุดสัญญา | หนี้เสีย

## Column variant differences between tabs
- **เป้าเก็บหนี้ (target)**: shows the *planned* schedule per installment (เงินต้น/ดอกเบี้ย/ค่าดำเนินการ as contracted)
- **ยอดเก็บหนี้ (collected)**: shows the *actual* payment per installment (เงินที่เก็บได้จริง / ดอกเบี้ยเก็บได้ / ค่าปรับ)

## Expected extra features requested by the user
- Search by `เลขที่สัญญา` (contract_no)
- Search by `ชื่อลูกค้า`
- Data source must come from our DB (not mock / not Excel upload)

## Collected tab (ยอดเก็บหนี้) — structural differences
- Per contract the table shows a primary row plus additional **sub-rows** labeled `- แบ่งชำระ -` in italic/faded style. These are actual partial payments tied to the same installment.
- Right-side extra columns visible: `วันเกิน`, `ปิดค่างวด`, `หนี้เสีย`, `ยอดที่ชำระรวม`, `งวดที่` — these summarize the collected side per installment.
- The collected group header reads `ข้อมูลชำระงวดที่ N` as well but its body shows actual amounts (0.00 when not yet paid).

## Layout conclusions for our implementation
- Primary data source: our `contracts` + `installments` + `payments` tables (already synced) — no Excel upload needed.
- Header "freeze" (sticky): first 9 columns (วันที่อนุมัติ … เกินกำหนด…) stay visible horizontally.
- Repeating installment groups render horizontally from งวดที่ 1..N. N = MAX(installment_count) across visible rows (capped e.g. at 36 for rendering; beyond that users can export).
- Both tabs share the left block; right installment block differs (Target vs Collected).
- Search box + status filter live in the header toolbar; tab switch is next to the title.

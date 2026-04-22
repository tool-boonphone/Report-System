# Contract Report — 41 Columns Mapping

Source of truth: `Ex-Super_Report.xls` (worksheet "Super report"), rows = 3509,
columns = 41. The order below MUST be preserved in the UI table and the
Excel export for BOTH sections (Boonphone / Fastfone365).

| # | Thai Header (Ex-Super_Report) | DB column (`contracts`) | Source (Boonphone API) |
|---|---|---|---|
| 1 | ลำดับ | _(row number, generated)_ | — |
| 2 | เลขที่สัญญา | `contractNo` | `data.contract.code` / list `contract_no` |
| 3 | วันยื่นสินเชื่อ | `submitDate` | `contract.created_at` / list `applied_at` (date part) |
| 4 | วันอนุมัติสัญญา | `approveDate` | `contract.approved.approved_at` / list `approved_at` (date part) |
| 5 | ช่องทาง | `channel` | detail `contract.order.status` ครอบคลุมช่องทาง — ตั้งต้น "หน้าร้าน" ถ้าไม่มี |
| 6 | สถานะสัญญา | `status` | `contract.status` / list `contract_status_code` |
| 7 | รหัสพาร์ทเนอร์ | `partnerCode` | detail `contract.partner.code + ' : ' + contract.partner.shop` |
| 8 | จังหวัดพาร์ทเนอร์ | `partnerProvince` | partner detail endpoint `partner_province` (join by partner_id) |
| 9 | ค่าคอมมิชชั่น สุทธิ | `commissionNet` | list `net_commission_amount` |
| 10 | สถานะพาร์ทเนอร์ | `partnerStatus` | partner detail `partner_status` ("active" → "ใช้งาน") |
| 11 | ชื่อลูกค้า | `customerName` | detail `contract.member.name` / `customer.full_name` |
| 12 | สัญชาติ | `nationality` | detail `contract.member.nationality` |
| 13 | เลขบัตรประชาชน/Passport | `citizenId` | detail `contract.member.identity_number` |
| 14 | เพศ | `gender` | detail `contract.member.sex` |
| 15 | อายุ(ปี) | `age` | customer endpoint `age_years` (join by customer_id) |
| 16 | ตำแหน่งงาน | `occupation` | detail `contract.occupation.career` |
| 17 | เงินเดือน/รายได้ | `salary` | detail `contract.occupation.income` |
| 18 | บริษัท/สถานที่ทำงาน | `workplace` | detail `contract.occupation.place` |
| 19 | โทรศัพท์ | `phone` | detail `contract.member.tel` |
| 20 | อำเภอ (ตามบัตร ปชช.) | `idDistrict` | detail `contract.card_address.amphure` |
| 21 | จังหวัด (ตามบัตร ปชช.) | `idProvince` | detail `contract.card_address.province` |
| 22 | อำเภอ (ที่อยู่ปัจจุบัน) | `addrDistrict` | detail `contract.contact_address.amphure` |
| 23 | จังหวัด (ที่อยู่ปัจจุบัน) | `addrProvince` | detail `contract.contact_address.province` |
| 24 | อำเภอ (ที่ทำงาน) | `workDistrict` | detail `contract.occupation.address.amphure` |
| 25 | จังหวัด (ที่ทำงาน) | `workProvince` | detail `contract.occupation.address.province` |
| 26 | Promotion ID | `promotionName` | list `promotion_name` |
| 27 | Device | `device` | list `product_category` (mapped: "โทรศัพท์มือถือ" → "iPhone"/"Android"; "แท็บเล็ต" → "iPad") |
| 28 | ประเภทสินค้า | `productType` | list `product_type` ("สินค้ามือ 2" → "2", "Sure+" etc.) |
| 29 | รุ่น | `model` | list `product_model` |
| 30 | Imei | `imei` | detail `contract.product.imei` |
| 31 | Serial No | `serialNo` | detail `contract.product.serial_no` |
| 32 | ราคาขาย | `sellPrice` | list `sale_price` |
| 33 | สถานะอุปกรณ์ | `deviceStatus` | default "ปกติ" (no API field yet) |
| 34 | ยอดดาวน์ | `downPayment` | list `down_payment_amount` |
| 35 | ยอดจัดไฟแนนซ์ | `financeAmount` | list `finance_amount` |
| 36 | จำนวนงวดผ่อน | `installmentCount` | list `term_count` |
| 37 | ตัวคูณ | `multiplier` | list `multiplier_rate` |
| 38 | ผ่อนงวดละ | `installmentAmount` | list `installment_amount` |
| 39 | ชำระทุกวันที่(ของทุกเดือน) | `paymentDay` | list `due_day_of_month` |
| 40 | งวดที่ชำระแล้ว | `paidInstallments` | list `paid_installment_count` |
| 41 | ประเภทหนี้ | `debtType` | list `debt_type` (default "ปกติ" when blank) |

## Notes
- คอลัมน์ #1 **ลำดับ** ถูกสร้างจากลำดับการเรียงในตาราง (หรือ excel) ไม่ได้เก็บใน DB
- ค่า "สถานะอุปกรณ์" ยังไม่มีใน API response → ให้ default = "ปกติ" และสามารถขยาย mapping ได้ภายหลัง
- ค่า "ช่องทาง" ถ้าไม่มี → default = "หน้าร้าน" ตามพฤติกรรมที่เห็นในไฟล์ตัวอย่าง
- "Device" อนุมานจาก `product_category`; ถ้าไม่ตรงใช้ค่าเดิม
- การ sync ใช้ 2 ขั้น: list-endpoint (เร็ว) + detail-endpoint (เติมข้อมูลลึก) เพื่อประหยัด rate-limit

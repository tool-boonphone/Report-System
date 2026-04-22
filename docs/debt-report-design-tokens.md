# Debt Report — design tokens (from reference boonphone.co.th/mm.html)

## Tab (active)
- เป้าเก็บหนี้: bg `rgb(79, 70, 229)` (indigo-600), text white
- ยอดเก็บหนี้: bg `rgb(225, 29, 72)` (rose-600), text white
- Inactive tab: bg `rgb(229, 231, 235)` (gray-200), text `rgb(75, 85, 99)` (gray-600)

## Period group header (tier-1)
- target tab: bg `rgb(79, 70, 229)` (indigo-600), text white
- collected tab: bg `rgb(225, 29, 72)` (rose-600), text white

## Period sub-header (tier-2 "งวดที่ / วันที่ต้องชำระ / เงินต้น / ...")
- target tab: alternates `rgb(238, 242, 255)` (indigo-50) and `rgb(224, 231, 255)` (indigo-100) every other period group. Text `rgb(49, 46, 129)` (indigo-900)
- collected tab: bg `rgb(255, 241, 242)` (rose-50), text `rgb(136, 19, 55)` (rose-900)

## Status badges
| Status | bg | text | border |
|---|---|---|---|
| ปกติ | green-100 `rgb(220,252,231)` | green-800 `rgb(22,101,52)` | green-300 `rgb(134,239,172)` |
| เกิน 1-7 | yellow-100 `rgb(254,249,195)` | yellow-900 `rgb(133,77,14)` | yellow-300 `rgb(253,224,71)` |
| เกิน 8-14 | amber-200 `rgb(253,230,138)` | amber-900 `rgb(146,64,14)` | amber-400 `rgb(251,191,36)` |
| เกิน 15-30 | orange-200 `rgb(254,215,170)` | orange-900 `rgb(124,45,18)` | orange-400 `rgb(251,146,60)` |
| เกิน 31-60 | red-200 `rgb(254,202,202)` | red-900 `rgb(153,27,27)` | red-400 `rgb(248,113,113)` |
| เกิน 61-90 | red-300 `rgb(252,165,165)` | red-900 `rgb(127,29,29)` | red-500 `rgb(239,68,68)` |
| เกิน >90 | rose-700 `rgb(190,18,60)` | white | rose-800 `rgb(159,18,57)` |
| ระงับสัญญา | gray-800 `rgb(31,41,55)` | white | gray-900 `rgb(17,24,39)` |
| สิ้นสุดสัญญา | blue-100 `rgb(219,234,254)` | blue-800 `rgb(30,64,175)` | blue-300 `rgb(147,197,253)` |
| หนี้เสีย | gray-700 `rgb(55,65,81)` | white | gray-800 `rgb(31,41,55)` |

## Overdue day cell
- Column header `เกินกำหนด(วัน)` — body shows a RED number in bold for `> 0` (and `0` when normal).

## Collected-tab sub-row "- แบ่งชำระ -"
- Italic, lighter gray text; indents + shows summary fields in italic. Already implemented as `text-amber-700 italic`.

## Annotation for overpaid target deduction (our extension)
- when `installments[N].amount < contract.installmentAmount` and `overpaidApplied > 0`:
  - show main amount bold, and below a thin line `(-หักชำระเกิน xxx.xx)` in `text-emerald-600 text-[10px]`
- when `amount === 0 && baseline > 0` and closed flag → show `0.00` + below `ปิดค่างวดแล้ว` in `text-sky-600 text-[10px]`
- when `bad debt` → show amount + below `ขายซาก` in `text-rose-600 text-[10px]`

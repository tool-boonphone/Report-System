/**
 * computePayPeriods.ts
 *
 * Pure accumulation-based period assignment for payment_transactions.
 *
 * ปัญหาของ assignPayPeriods เดิม:
 *   - พึ่ง receipt_no format (TXRT-N) ซึ่ง Fastfone365 ใช้ format ต่างกัน
 *   - ยอดงวดของ Fastfone365 ไม่คงที่ ทำให้ amount-based cursor stall
 *   - ผลคือทุก payment ถูก assign ให้งวดเดิมซ้ำๆ
 *
 * วิธีใหม่ (pure accumulation):
 *   1. เรียง payments ตามวันที่ (paid_at ASC)
 *   2. สะสมยอด (accumulated) ทีละ payment
 *   3. เมื่อ accumulated >= installment[X].amount → ข้ามไปงวด X+1
 *   4. ถ้า payment เดียวครอบคลุมหลายงวด → split เป็นหลาย rows
 *
 * Output: array ของ { externalId, periodNo, subNo }
 * ใช้สำหรับ UPDATE payment_transactions ทีละ batch
 */

export type InstallmentScheduleItem = {
  period: number;
  amount: number; // ยอดงวดนั้น (principal + interest + fee)
};

export type PaymentInputRow = {
  id: number;
  externalId: string;
  paidAt: string | null;
  amount: number; // ยอดที่จ่ายจริง (จาก payment_transactions.amount)
  rawJson?: Record<string, unknown> | null;
};

export type PeriodAssignment = {
  id: number;
  externalId: string;
  periodNo: number;
  subNo: number;
};

/**
 * computePayPeriods
 *
 * Input:
 *   payments    — list ของ payment rows สำหรับสัญญาเดียว
 *   schedule    — installment schedule (period, amount) เรียงตาม period ASC
 *
 * Output:
 *   array ของ { id, externalId, periodNo, subNo }
 *   ถ้า payment ครอบคลุมหลายงวด จะมี entry เดียวต่อ payment
 *   (เราไม่ split rows ใน DB จริง — periodNo = งวดที่ payment นี้เริ่มต้น)
 *
 * หมายเหตุ: สำหรับ split ที่ payment ครอบคลุมหลายงวด เราเก็บ periodNo = งวดแรก
 * ที่ payment นี้ครอบคลุม และ subNo = ลำดับย่อยภายในงวดนั้น
 * การ display "งวด X/total" จะใช้ MAX(periodNo) ของ payments ที่ชำระแล้ว
 */
export function computePayPeriods(
  payments: PaymentInputRow[],
  schedule: InstallmentScheduleItem[],
): PeriodAssignment[] {
  if (!payments.length || !schedule.length) return [];

  // เรียง schedule ตาม period ASC
  const sortedSchedule = [...schedule]
    .filter((s) => s.period != null && s.amount > 0)
    .sort((a, b) => a.period - b.period);

  if (!sortedSchedule.length) return [];

  // เรียง payments ตาม paid_at ASC, tie-break ด้วย id ASC
  const sortedPayments = [...payments].sort((a, b) => {
    const at = a.paidAt ?? "";
    const bt = b.paidAt ?? "";
    if (at !== bt) return at.localeCompare(bt);
    return a.id - b.id;
  });

  // ตัวแปรสะสม
  let cursorIdx = 0; // index ใน sortedSchedule (งวดปัจจุบัน)
  let accumulated = 0; // ยอดสะสมที่ยังไม่ครบงวดปัจจุบัน

  // นับ subNo ต่อ periodNo
  const subNoCounter = new Map<number, number>();

  const result: PeriodAssignment[] = [];

  for (const pay of sortedPayments) {
    // ถ้า cursor เกิน schedule แล้ว → assign งวดสุดท้าย
    if (cursorIdx >= sortedSchedule.length) {
      cursorIdx = sortedSchedule.length - 1;
    }

    const currentPeriod = sortedSchedule[cursorIdx].period;

    // นับ subNo สำหรับงวดนี้
    const sub = (subNoCounter.get(currentPeriod) ?? 0) + 1;
    subNoCounter.set(currentPeriod, sub);

    result.push({
      id: pay.id,
      externalId: pay.externalId,
      periodNo: currentPeriod,
      subNo: sub,
    });

    // สะสมยอด
    accumulated += pay.amount;

    // เลื่อน cursor เมื่อสะสมครบงวดปัจจุบัน (tolerance 0.5 บาท)
    while (
      cursorIdx < sortedSchedule.length - 1 &&
      sortedSchedule[cursorIdx].amount > 0 &&
      accumulated >= sortedSchedule[cursorIdx].amount - 0.5
    ) {
      accumulated -= sortedSchedule[cursorIdx].amount;
      cursorIdx += 1;
      // reset subNo counter สำหรับงวดใหม่ (ยังไม่มีใครใช้)
    }

    // ป้องกัน accumulated ติดลบ (floating point)
    if (accumulated < 0) accumulated = 0;
  }

  return result;
}

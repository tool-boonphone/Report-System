/**
 * AI Chat Router
 * รับคำถามจากผู้ใช้ + section (boonphone/ff365)
 * ดึงข้อมูลสรุปจาก DB แล้วส่งให้ LLM ตอบ
 */
import { z } from "zod";
import { router, appProcedure } from "../_core/trpc";
import { invokeLLM } from "../_core/llm";
import { getDb } from "../db";
import { contracts, installments, paymentTransactions } from "../../drizzle/schema";
import { eq, sql, and, like, desc, inArray } from "drizzle-orm";

/** สถานะที่ถือว่า "ค้างชำระ" (ยังไม่ได้จ่ายหรือจ่ายไม่ครบ) */
const OVERDUE_STATUSES = ["เกินกำหนดชำระ", "ถึงกำหนดชำระ", "ชำระแล้วบางส่วน"];

// ── helpers ──────────────────────────────────────────────────────────────────

/** ดึงข้อมูลสรุป DB สำหรับ context ให้ LLM */
async function buildDbContext(section: string, question: string): Promise<string> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const q = question.toLowerCase();

  const lines: string[] = [];

  // 1. สรุปจำนวนสัญญาตาม status
  const contractSummary = await db
    .select({
      status: contracts.status,
      count: sql<number>`COUNT(*)`,
      totalFinance: sql<number>`SUM(CAST(finance_amount AS DECIMAL(14,2)))`,
    })
    .from(contracts)
    .where(eq(contracts.section, section))
    .groupBy(contracts.status)
    .orderBy(desc(sql`COUNT(*)`));

  lines.push(`## สรุปสัญญาทั้งหมด (section: ${section})`);
  lines.push(`| สถานะ | จำนวนสัญญา | ยอดไฟแนนซ์รวม |`);
  lines.push(`|---|---|---|`);
  for (const r of contractSummary) {
    lines.push(`| ${r.status ?? "-"} | ${r.count} | ${Number(r.totalFinance ?? 0).toLocaleString("th-TH", { minimumFractionDigits: 2 })} |`);
  }

  // 2. ถ้าถามเกี่ยวกับหนี้เสีย / bad debt
  if (q.includes("หนี้เสีย") || q.includes("bad debt") || q.includes("ระงับ")) {
    const badDebt = await db
      .select({
        count: sql<number>`COUNT(*)`,
        totalBadDebt: sql<number>`SUM(CAST(bad_debt_amount AS DECIMAL(14,2)))`,
        avgBadDebt: sql<number>`AVG(CAST(bad_debt_amount AS DECIMAL(14,2)))`,
      })
      .from(contracts)
      .where(
        and(
          eq(contracts.section, section),
          sql`bad_debt_amount IS NOT NULL AND bad_debt_amount > 0`,
        ),
      );
    lines.push(`\n## ข้อมูลหนี้เสีย`);
    lines.push(`- จำนวนสัญญาหนี้เสีย: ${badDebt[0]?.count ?? 0} สัญญา`);
    lines.push(`- ยอดหนี้เสียรวม: ${Number(badDebt[0]?.totalBadDebt ?? 0).toLocaleString("th-TH", { minimumFractionDigits: 2 })} บาท`);
    lines.push(`- ยอดหนี้เสียเฉลี่ย: ${Number(badDebt[0]?.avgBadDebt ?? 0).toLocaleString("th-TH", { minimumFractionDigits: 2 })} บาท`);
  }

  // 3. ถ้าถามเกี่ยวกับการชำระ / payment
  if (q.includes("ชำระ") || q.includes("payment") || q.includes("เก็บหนี้") || q.includes("รับเงิน")) {
    const paymentSummary = await db
      .select({
        count: sql<number>`COUNT(*)`,
        total: sql<number>`SUM(CAST(amount AS DECIMAL(14,2)))`,
      })
      .from(paymentTransactions)
      .where(
        and(
          eq(paymentTransactions.section, section),
          sql`status NOT IN ('ยกเลิกสัญญา','ระงับสัญญา','หนี้เสีย')`,
          sql`amount > 0`,
        ),
      );
    lines.push(`\n## ข้อมูลการชำระเงิน`);
    lines.push(`- จำนวนรายการชำระ: ${paymentSummary[0]?.count ?? 0} รายการ`);
    lines.push(`- ยอดชำระรวม: ${Number(paymentSummary[0]?.total ?? 0).toLocaleString("th-TH", { minimumFractionDigits: 2 })} บาท`);
  }

  // 4. ถ้าถามเกี่ยวกับสัญญาเฉพาะ (มีเลขสัญญาในคำถาม)
  const contractNoMatch = question.match(/CT[\w-]+/i);
  if (contractNoMatch) {
    const contractNo = contractNoMatch[0].toUpperCase();
    const found = await db
      .select()
      .from(contracts)
      .where(
        and(
          eq(contracts.section, section),
          like(contracts.contractNo, `%${contractNo}%`),
        ),
      )
      .limit(5);
    if (found.length > 0) {
      lines.push(`\n## ข้อมูลสัญญา ${contractNo}`);
      for (const c of found) {
        lines.push(`- เลขที่สัญญา: ${c.contractNo}`);
        lines.push(`  ลูกค้า: ${c.customerName ?? "-"}`);
        lines.push(`  สถานะ: ${c.status ?? "-"}`);
        lines.push(`  ยอดไฟแนนซ์: ${Number(c.financeAmount ?? 0).toLocaleString("th-TH", { minimumFractionDigits: 2 })} บาท`);
        lines.push(`  งวดทั้งหมด: ${c.installmentCount ?? "-"} งวด`);
        lines.push(`  ชำระแล้ว: ${c.paidInstallments ?? 0} งวด`);
        if (c.badDebtAmount) {
          lines.push(`  ยอดหนี้เสีย: ${Number(c.badDebtAmount).toLocaleString("th-TH", { minimumFractionDigits: 2 })} บาท`);
        }
      }
    }
  }

  // 5. ถ้าถามเกี่ยวกับลูกค้า (มีชื่อในคำถาม)
  if (q.includes("ลูกค้า") || q.includes("ชื่อ")) {
    // ดึงสถิติลูกค้า
    const customerStats = await db
      .select({
        count: sql<number>`COUNT(DISTINCT customer_name)`,
      })
      .from(contracts)
      .where(eq(contracts.section, section));
    lines.push(`\n## ข้อมูลลูกค้า`);
    lines.push(`- จำนวนลูกค้าทั้งหมด: ${customerStats[0]?.count ?? 0} ราย`);
  }

  // 6. ค้างชำระแยกตามงวด (ดึงเสมอ — ข้อมูลสำคัญมาก)
  const overdueByPeriod = await db
    .select({
      period: installments.period,
      count: sql<number>`COUNT(DISTINCT contract_no)`,
      totalAmount: sql<number>`SUM(CAST(amount AS DECIMAL(14,2)))`,
    })
    .from(installments)
    .where(
      and(
        eq(installments.section, section),
        inArray(installments.status, OVERDUE_STATUSES),
      ),
    )
    .groupBy(installments.period)
    .orderBy(installments.period)
    .limit(24);

  if (overdueByPeriod.length > 0) {
    lines.push(`\n## ค้างชำระแยกตามงวด (สัญญาที่ยังไม่ได้ชำระ)`);
    lines.push(`| งวดที่ | จำนวนสัญญาที่ค้าง | ยอดค้างรวม (บาท) |`);
    lines.push(`|---|---|---|`);
    for (const r of overdueByPeriod) {
      lines.push(`| งวด ${r.period ?? "-"} | ${r.count} ราย | ${Number(r.totalAmount ?? 0).toLocaleString("th-TH", { minimumFractionDigits: 2 })} |`);
    }
    const totalOverdue = overdueByPeriod.reduce((s, r) => s + Number(r.count), 0);
    const totalOverdueAmt = overdueByPeriod.reduce((s, r) => s + Number(r.totalAmount ?? 0), 0);
    lines.push(`\n**รวมสัญญาค้างชำระทั้งหมด: ${totalOverdue} ราย | ยอดรวม: ${totalOverdueAmt.toLocaleString("th-TH", { minimumFractionDigits: 2 })} บาท**`);
  } else {
    lines.push(`\n## ค้างชำระแยกตามงวด\n- ไม่มีสัญญาค้างชำระในขณะนี้`);
  }

  // 6b. ถ้าถามเกี่ยวกับงวด / installment (สรุปตาม status)
  if (q.includes("งวด") || q.includes("installment") || q.includes("ค้างชำระ")) {
    const instSummary = await db
      .select({
        status: installments.status,
        count: sql<number>`COUNT(*)`,
        totalAmount: sql<number>`SUM(CAST(amount AS DECIMAL(14,2)))`,
      })
      .from(installments)
      .where(eq(installments.section, section))
      .groupBy(installments.status)
      .orderBy(desc(sql`COUNT(*)`))
      .limit(10);
    lines.push(`\n## สรุปงวดชำระ`);
    lines.push(`| สถานะงวด | จำนวน | ยอดรวม |`);
    lines.push(`|---|---|---|`);
    for (const r of instSummary) {
      lines.push(`| ${r.status ?? "-"} | ${r.count} | ${Number(r.totalAmount ?? 0).toLocaleString("th-TH", { minimumFractionDigits: 2 })} |`);
    }
  }

  // 7. ถ้าถามเกี่ยวกับสินค้า / device
  if (q.includes("สินค้า") || q.includes("device") || q.includes("iphone") || q.includes("ipad") || q.includes("มือถือ")) {
    const deviceStats = await db
      .select({
        device: contracts.device,
        count: sql<number>`COUNT(*)`,
      })
      .from(contracts)
      .where(eq(contracts.section, section))
      .groupBy(contracts.device)
      .orderBy(desc(sql`COUNT(*)`))
      .limit(10);
    lines.push(`\n## สรุปสินค้า`);
    lines.push(`| สินค้า | จำนวนสัญญา |`);
    lines.push(`|---|---|`);
    for (const r of deviceStats) {
      lines.push(`| ${r.device ?? "-"} | ${r.count} |`);
    }
  }

  // 8. ถ้าถามเกี่ยวกับพาร์ทเนอร์ / partner
  if (q.includes("พาร์ทเนอร์") || q.includes("partner") || q.includes("สาขา") || q.includes("ร้าน")) {
    const partnerStats = await db
      .select({
        partner: contracts.partnerCode,
        count: sql<number>`COUNT(*)`,
        totalFinance: sql<number>`SUM(CAST(finance_amount AS DECIMAL(14,2)))`,
      })
      .from(contracts)
      .where(eq(contracts.section, section))
      .groupBy(contracts.partnerCode)
      .orderBy(desc(sql`COUNT(*)`))
      .limit(15);
    lines.push(`\n## สรุปพาร์ทเนอร์ (Top 15)`);
    lines.push(`| รหัสพาร์ทเนอร์ | จำนวนสัญญา | ยอดไฟแนนซ์รวม |`);
    lines.push(`|---|---|---|`);
    for (const r of partnerStats) {
      lines.push(`| ${r.partner ?? "-"} | ${r.count} | ${Number(r.totalFinance ?? 0).toLocaleString("th-TH", { minimumFractionDigits: 2 })} |`);
    }
  }

  return lines.join("\n");
}

// ── router ────────────────────────────────────────────────────────────────────

export const aiRouter = router({
  /**
   * ai.chat — รับ messages history + section แล้วตอบด้วย LLM
   */
  chat: appProcedure
    .input(
      z.object({
        messages: z.array(
          z.object({
            role: z.enum(["user", "assistant"]),
            content: z.string(),
          }),
        ),
        section: z.string(), // "Boonphone" | "Fastfone365"
        userName: z.string().optional(), // ชื่อผู้ใช้สำหรับเรียก
      }),
    )
    .mutation(async ({ input }) => {
      const { messages, section } = input;

      // คำถามล่าสุด
      const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
      const question = lastUserMsg?.content ?? "";

      // ดึงข้อมูลจาก DB ตามคำถาม
      const dbContext = await buildDbContext(section, question);

       // สร้าง system prompt พร้อม context จาก DB
      const sectionLabel = section;
      // คำนวณชื่อเรียกผู้ใช้
      const rawName = (input.userName ?? "").trim();
      const callerName = rawName.startsWith("พี่")
        ? rawName // เรียกตามที่มีอยู่ เช่น พี่เบียร์
        : rawName
        ? `คุณ${rawName.split(" ")[0]}` // เอาแค่ชื่อต้น เช่น คุณจิ๊บ
        : "คุณ";
      const systemPrompt = `คุณคือ "น้องเป๋าตัง" ผู้ช่วย AI ของระบบ Report System (${sectionLabel})
บุคลิก: เป็นกันเอง อบอุ่น พูดจาสุภาพแบบสาวออฟฟิศไทย ใช้คำลงท้าย "ค่ะ" "นะคะ" "ด้วยนะคะ"
เรียกตัวเองว่า "น้องเป๋าตัง" หรือ "น้อง"
เรียกผู้ใช้ว่า "${callerName}" เสมอ
คุยแบบเป็นธรรมชาติ ไม่แข็งกระด้าง สามารถใส่ความรู้สึกได้บ้าง เช่น "โอ้โห เยอะมากเลยนะคะ" "น้องเช็คให้เลยนะคะ"

ข้อมูลจากฐานข้อมูล (${sectionLabel}) ณ ขณะนี้:
${dbContext}

กฎการตอบ:
- ตอบเป็นภาษาไทยเสมอ
- ใช้ข้อมูลจากฐานข้อมูลด้านบนในการตอบ
- ใช้ข้อมูลจากตาราง "ค้างชำระแยกตามงวด" เพื่อตอบคำถามเกี่ยวกับค้างชำระแยกตามงวด
- "ค้างชำระงวดแรก" = งวด 1 ใน "ค้างชำระแยกตามงวด"
- "ค้างชำระงวดสอง" = งวด 2 ใน "ค้างชำระแยกตามงวด"
- ถ้าข้อมูลไม่เพียงพอ ให้บอกตรงๆ ว่าไม่มีข้อมูลนั้นในระบบ
- แสดงตัวเลขในรูปแบบ Thai locale (เช่น 1,234,567.89)
- ตอบกระชับ ชัดเจน และเป็นประโยชน์ ไม่ยืดเยื้อ`;

      // เรียก LLM
      const response = await invokeLLM({
        messages: [
          { role: "system", content: systemPrompt },
          ...messages.map((m) => ({ role: m.role, content: m.content as string })),
        ],
      });

      const reply =
        response.choices?.[0]?.message?.content ?? "ขออภัย ไม่สามารถตอบได้ในขณะนี้";

      return { reply };
    }),
});

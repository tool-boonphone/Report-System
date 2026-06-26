/**
 * bahtText.ts — แปลงจำนวนเงิน (บาท) เป็นข้อความภาษาไทย เช่น 13960 → "หนึ่งหมื่นสามพันเก้าร้อยหกสิบบาทถ้วน"
 * รองรับทศนิยม 2 ตำแหน่ง (สตางค์)
 */
const THAI_DIGITS = ["", "หนึ่ง", "สอง", "สาม", "สี่", "ห้า", "หก", "เจ็ด", "แปด", "เก้า"];
const THAI_PLACES = ["", "สิบ", "ร้อย", "พัน", "หมื่น", "แสน", "ล้าน"];

/** อ่านจำนวนเต็ม (สูงสุดถึงหลักล้าน ๆ ด้วยการตัดเป็นกลุ่มล้าน) เป็นข้อความไทย */
function readInteger(numStr: string): string {
  // ตัดเป็นกลุ่มละ 6 หลักจากขวา (หลักล้าน) แล้วต่อด้วย "ล้าน"
  if (numStr === "0" || numStr === "") return "ศูนย์";
  let result = "";
  let groups: string[] = [];
  let s = numStr;
  while (s.length > 6) {
    groups.unshift(s.slice(-6));
    s = s.slice(0, -6);
  }
  groups.unshift(s);

  groups.forEach((group, gi) => {
    const isLast = gi === groups.length - 1;
    const text = readUpToSixDigits(group);
    if (text) {
      result += text;
      if (!isLast) result += "ล้าน";
    } else if (!isLast && result) {
      // กลุ่มเป็นศูนย์แต่ยังมีกลุ่มถัดไป → ยังต้องเติม "ล้าน" เพื่อรักษาหลัก
      result += "ล้าน";
    }
  });
  return result || "ศูนย์";
}

/** อ่านเลขไม่เกิน 6 หลัก */
function readUpToSixDigits(group: string): string {
  const digits = group.replace(/^0+/, "");
  if (digits === "") return "";
  const len = digits.length;
  let out = "";
  for (let i = 0; i < len; i++) {
    const d = Number(digits[i]);
    const place = len - i - 1; // 0=หน่วย,1=สิบ,...
    if (d === 0) continue;
    if (place === 0) {
      // หลักหน่วย
      if (d === 1 && len > 1) out += "เอ็ด";
      else out += THAI_DIGITS[d];
    } else if (place === 1) {
      // หลักสิบ
      if (d === 1) out += "สิบ";
      else if (d === 2) out += "ยี่สิบ";
      else out += THAI_DIGITS[d] + "สิบ";
    } else {
      out += THAI_DIGITS[d] + THAI_PLACES[place];
    }
  }
  return out;
}

/** แปลงจำนวนเงินบาทเป็นข้อความไทยเต็มรูป (ลงท้ายด้วย "บาทถ้วน" หรือ "...สตางค์") */
export function bahtText(amount: number | string | null | undefined): string {
  const n = Number(amount ?? 0);
  if (!Number.isFinite(n)) return "ศูนย์บาทถ้วน";
  const negative = n < 0;
  const abs = Math.abs(n);
  // ปัดเป็น 2 ตำแหน่ง
  const rounded = Math.round(abs * 100) / 100;
  const bahtPart = Math.floor(rounded);
  const satangPart = Math.round((rounded - bahtPart) * 100);

  let text = "";
  if (bahtPart > 0) {
    text += readInteger(String(bahtPart)) + "บาท";
  }
  if (satangPart > 0) {
    text += readInteger(String(satangPart)) + "สตางค์";
  } else {
    text = (text || readInteger("0") + "บาท") + "ถ้วน";
  }
  if (bahtPart === 0 && satangPart > 0) {
    // เฉพาะสตางค์ (ไม่มีบาท) — ไม่ต้องมี "ถ้วน"
    text = readInteger(String(satangPart)) + "สตางค์";
  }
  return (negative ? "ลบ" : "") + text;
}

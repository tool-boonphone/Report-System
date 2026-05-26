/**
 * MonthlySummary — สรุปรายเดือน (Phase 129)
 *
 * 6 แถบ:
 *   1. จำนวนสัญญา   (count)          — slate
 *   2. ยอดผ่อนรวม   (installTotal)   — purple (net_amount ทุกงวด = principal+interest+fee)
 *   3. เป้าเก็บหนี้   (target)         — indigo (งวดที่ถึงกำหนดแล้ว)
 *   4. ยอดเก็บหนี้    (paid)           — green
 *   5. หนี้ค้างชำระ   (due)            — orange
 *   6. ยังไม่ถึงกำหนด (notYetDue)     — blue
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { SyncStatusBar } from "@/components/SyncStatusBar";
import { useNavActions } from "@/contexts/NavActionsContext";
import { useSection } from "@/contexts/SectionContext";
import { useAppAuth } from "@/hooks/useAppAuth";
import { trpc } from "@/lib/trpc";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import {
  Banknote, CalendarDays, Check, ChevronsUpDown, Coins, Download,
  Eye, EyeOff, Gavel, Percent, Smartphone, Tag, TrendingUp, X,
  ArrowUp, ArrowDown, Info, Search,
} from "lucide-react";
import { toast } from "sonner";
import * as XLSX from "xlsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

// ─── Constants ───────────────────────────────────────────────────────────────
const DEBT_BUCKETS = [
  "ปกติ","เกิน 1-7","เกิน 8-14","เกิน 15-30","เกิน 31-60",
  "เกิน 61-90","เกิน >90","ระงับสัญญา","สิ้นสุดสัญญา","หนี้เสีย","ยกเลิกสัญญา",
] as const;
type DebtBucket = (typeof DEBT_BUCKETS)[number];

type ColGroup = { key: string; label: string; buckets: DebtBucket[]; headerBg: string; hasSubtotal: boolean };
const COL_GROUPS: ColGroup[] = [
  { key:"normal",     label:"ปกติ",         buckets:["ปกติ","เกิน 1-7","เกิน 8-14","เกิน 15-30","เกิน 31-60"], headerBg:"bg-green-700",  hasSubtotal:true  },
  { key:"suspect",    label:"สงสัยจะเสีย", buckets:["เกิน 61-90","เกิน >90"],                                   headerBg:"bg-orange-700", hasSubtotal:true  },
  { key:"standalone", label:"",             buckets:["ระงับสัญญา","สิ้นสุดสัญญา","หนี้เสีย","ยกเลิกสัญญา"],   headerBg:"bg-gray-700",   hasSubtotal:false },
];

// ─── Types ────────────────────────────────────────────────────────────────────
type MoneyBreakdown = {
  principal:number; interest:number; fee:number; penalty:number;
  unlockFee:number; discount:number; overpaid:number;
  badDebt:number; badDebtInstallment:number; total:number;
};
type SummaryCell = {
  contractCount:number;
  paid:MoneyBreakdown;
  due:MoneyBreakdown;
  target:MoneyBreakdown;
  notYetDue:MoneyBreakdown;
  installTotal:MoneyBreakdown; // ยอดผ่อนรวม = SUM(net_amount) ทุกงวด (principal+interest+fee)
};
type SummaryRow = {
  approveMonth:string;
  buckets:Record<string,SummaryCell>;
  totalCount:number;
  totalPaid:MoneyBreakdown;
  totalDue:MoneyBreakdown;
  totalTarget:MoneyBreakdown;
  totalNotYetDue:MoneyBreakdown;
  totalInstallTotal:MoneyBreakdown;
};
type TabKey = "count"|"installTotal"|"target"|"paid"|"due"|"notYetDue"|"combined";
type MoneyBadgeKey = "principal"|"interest"|"fee"|"penalty"|"unlockFee"|"discount"|"overpaid"|"badDebtInstallment";
type DueBadgeKey       = "principal"|"interest"|"fee"|"penalty"|"unlockFee";
type NotYetDueBadgeKey = "principal"|"interest"|"fee";
type GrandTotal = {
  bucketTotals:Record<string,{count:number;paid:MoneyBreakdown;due:MoneyBreakdown;target:MoneyBreakdown;notYetDue:MoneyBreakdown;installTotal:MoneyBreakdown}>;
  totalCount:number;
  totalPaid:MoneyBreakdown;
  totalDue:MoneyBreakdown;
  totalTarget:MoneyBreakdown;
  totalNotYetDue:MoneyBreakdown;
  totalInstallTotal:MoneyBreakdown;
};
type SortDir = "asc"|"desc";

// Flat row type (matches router return)
type FlatRow = {
  approveMonth:string; bucket:string; contractCount:number;
  paidPrincipal:number; paidInterest:number; paidFee:number; paidPenalty:number;
  paidUnlockFee:number; paidDiscount:number; paidOverpaid:number;
  paidBadDebt:number; paidBadDebtInstallment:number; paidTotal:number;
  duePrincipal:number; dueInterest:number; dueFee:number; duePenalty:number; dueUnlockFee:number; dueTotal:number;
  targetPrincipal:number; targetInterest:number; targetFee:number; targetPenalty:number; targetUnlockFee:number; targetTotal:number;
  notYetDuePrincipal:number; notYetDueInterest:number; notYetDueFee:number; notYetDuePenalty:number; notYetDueUnlockFee:number; notYetDueTotal:number;
  installTotalPrincipal:number; installTotalInterest:number; installTotalFee:number; installTotalTotal:number;
};

function emptyMoney():MoneyBreakdown {
  return {principal:0,interest:0,fee:0,penalty:0,unlockFee:0,discount:0,overpaid:0,badDebt:0,badDebtInstallment:0,total:0};
}

/** Group flat rows จาก router → SummaryRow[] */
function groupFlatRows(flatRows:FlatRow[]):SummaryRow[] {
  const monthMap=new Map<string,SummaryRow>();
  for(const fr of flatRows){
    if(!fr||typeof fr.approveMonth!=="string"||!fr.approveMonth)continue;
    if(fr.bucket==="__total__"){
      const row=monthMap.get(fr.approveMonth);
      if(row){
        row.totalCount=fr.contractCount;
        row.totalPaid={principal:fr.paidPrincipal,interest:fr.paidInterest,fee:fr.paidFee,penalty:fr.paidPenalty,unlockFee:fr.paidUnlockFee,discount:fr.paidDiscount,overpaid:fr.paidOverpaid,badDebt:fr.paidBadDebt,badDebtInstallment:fr.paidBadDebtInstallment,total:fr.paidTotal};
        row.totalDue={principal:fr.duePrincipal,interest:fr.dueInterest,fee:fr.dueFee,penalty:fr.duePenalty,unlockFee:fr.dueUnlockFee,discount:0,overpaid:0,badDebt:0,badDebtInstallment:0,total:fr.dueTotal};
        row.totalTarget={principal:fr.targetPrincipal,interest:fr.targetInterest,fee:fr.targetFee,penalty:fr.targetPenalty,unlockFee:fr.targetUnlockFee,discount:0,overpaid:0,badDebt:0,badDebtInstallment:0,total:fr.targetTotal};
        row.totalNotYetDue={principal:fr.notYetDuePrincipal,interest:fr.notYetDueInterest,fee:fr.notYetDueFee,penalty:fr.notYetDuePenalty,unlockFee:fr.notYetDueUnlockFee,discount:0,overpaid:0,badDebt:0,badDebtInstallment:0,total:fr.notYetDueTotal};
        row.totalInstallTotal={principal:fr.installTotalPrincipal??0,interest:fr.installTotalInterest??0,fee:fr.installTotalFee??0,penalty:0,unlockFee:0,discount:0,overpaid:0,badDebt:0,badDebtInstallment:0,total:fr.installTotalTotal??0};
      }
      continue;
    }
    if(!monthMap.has(fr.approveMonth))monthMap.set(fr.approveMonth,{
      approveMonth:fr.approveMonth,buckets:{},totalCount:0,
      totalPaid:emptyMoney(),totalDue:emptyMoney(),totalTarget:emptyMoney(),totalNotYetDue:emptyMoney(),totalInstallTotal:emptyMoney(),
    });
    const row=monthMap.get(fr.approveMonth)!;
    row.buckets[fr.bucket]={
      contractCount:fr.contractCount,
      paid:{principal:fr.paidPrincipal,interest:fr.paidInterest,fee:fr.paidFee,penalty:fr.paidPenalty,unlockFee:fr.paidUnlockFee,discount:fr.paidDiscount,overpaid:fr.paidOverpaid,badDebt:fr.paidBadDebt,badDebtInstallment:fr.paidBadDebtInstallment,total:fr.paidTotal},
      due:{principal:fr.duePrincipal,interest:fr.dueInterest,fee:fr.dueFee,penalty:fr.duePenalty,unlockFee:fr.dueUnlockFee,discount:0,overpaid:0,badDebt:0,badDebtInstallment:0,total:fr.dueTotal},
      target:{principal:fr.targetPrincipal,interest:fr.targetInterest,fee:fr.targetFee,penalty:fr.targetPenalty,unlockFee:fr.targetUnlockFee,discount:0,overpaid:0,badDebt:0,badDebtInstallment:0,total:fr.targetTotal},
      notYetDue:{principal:fr.notYetDuePrincipal,interest:fr.notYetDueInterest,fee:fr.notYetDueFee,penalty:fr.notYetDuePenalty,unlockFee:fr.notYetDueUnlockFee,discount:0,overpaid:0,badDebt:0,badDebtInstallment:0,total:fr.notYetDueTotal},
      installTotal:{principal:fr.installTotalPrincipal??0,interest:fr.installTotalInterest??0,fee:fr.installTotalFee??0,penalty:0,unlockFee:0,discount:0,overpaid:0,badDebt:0,badDebtInstallment:0,total:fr.installTotalTotal??0},
    };
  }
  return Array.from(monthMap.values()).sort((a,b)=>b.approveMonth.localeCompare(a.approveMonth));
}

// ─── Badge items ──────────────────────────────────────────────────────────────
const MONEY_BADGE_ITEMS: Array<{key:MoneyBadgeKey;label:string;icon:React.ReactNode;canToggle:boolean}> = [
  { key:"principal",          label:"เงินต้น",          icon:<Banknote   className="w-3.5 h-3.5"/>, canToggle:true  },
  { key:"interest",           label:"ดอกเบี้ย",         icon:<Percent    className="w-3.5 h-3.5"/>, canToggle:true  },
  { key:"fee",                label:"ค่าดำเนินการ",     icon:<Coins      className="w-3.5 h-3.5"/>, canToggle:true  },
  { key:"penalty",            label:"ค่าปรับ",          icon:<Gavel      className="w-3.5 h-3.5"/>, canToggle:true  },
  { key:"unlockFee",          label:"ค่าปลดล็อก",       icon:<Tag        className="w-3.5 h-3.5"/>, canToggle:true  },
  { key:"discount",           label:"ส่วนลด",           icon:<Tag        className="w-3.5 h-3.5"/>, canToggle:false },
  { key:"overpaid",           label:"ชำระเกิน",         icon:<TrendingUp className="w-3.5 h-3.5"/>, canToggle:true  },
];
const DUE_BADGE_ITEMS: Array<{key:DueBadgeKey;label:string;icon:React.ReactNode}> = [
  { key:"principal", label:"เงินต้น",      icon:<Banknote className="w-3.5 h-3.5"/> },
  { key:"interest",  label:"ดอกเบี้ย",     icon:<Percent  className="w-3.5 h-3.5"/> },
  { key:"fee",       label:"ค่าดำเนินการ", icon:<Coins    className="w-3.5 h-3.5"/> },
  { key:"penalty",   label:"ค่าปรับ",      icon:<Gavel    className="w-3.5 h-3.5"/> },
  { key:"unlockFee", label:"ค่าปลดล็อก",   icon:<Tag      className="w-3.5 h-3.5"/> },
];
// Badge ยังไม่ถึงกำหนด: เฉพาะ เงินต้น, ดอกเบี้ย, ค่าดำเนินการ (ไม่มีค่าปรับ/ค่าปลดล็อก)
const NOT_YET_DUE_BADGE_ITEMS: Array<{key:NotYetDueBadgeKey;label:string;icon:React.ReactNode}> = [
  { key:"principal", label:"เงินต้น",      icon:<Banknote className="w-3.5 h-3.5"/> },
  { key:"interest",  label:"ดอกเบี้ย",     icon:<Percent  className="w-3.5 h-3.5"/> },
  { key:"fee",       label:"ค่าดำเนินการ", icon:<Coins    className="w-3.5 h-3.5"/> },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function computeMoneyTotal(m:MoneyBreakdown, v:Record<MoneyBadgeKey,boolean>):number {
  // m.total = total_paid จาก DB ซึ่ง discount ถูกหักออกแล้วตั้งแต่ตอน sync
  // (payment_tx_amount = pt.amount ซึ่งเป็นยอดที่จ่ายจริงหลังหัก discount แล้ว)
  // ดังนั้น m.total ไม่รวม discount → ไม่ต้องหัก m.discount ซ้ำอีก
  // ต้องหักแค่ m.badDebt เพราะ badDebt จัดการแยกโดย caller (bucket หนี้เสีย)
  const installmentBase = m.total - m.badDebt;
  return installmentBase
    - (!v.principal ? m.principal : 0)
    - (!v.interest  ? m.interest  : 0)
    - (!v.fee       ? m.fee       : 0)
    - (!v.penalty   ? m.penalty   : 0)
    - (!v.unlockFee ? m.unlockFee : 0)
    - (!v.overpaid  ? m.overpaid  : 0);
}
function computeDueTotal(m:MoneyBreakdown, v:Record<DueBadgeKey,boolean>):number {
  return (v.principal?m.principal:0)+(v.interest?m.interest:0)+(v.fee?m.fee:0)+(v.penalty?m.penalty:0)+(v.unlockFee?m.unlockFee:0);
}
function computeNotYetDueTotal(m:MoneyBreakdown, v:Record<NotYetDueBadgeKey,boolean>):number {
  return (v.principal?m.principal:0)+(v.interest?m.interest:0)+(v.fee?m.fee:0);
}
function addMoney(a:MoneyBreakdown, b:MoneyBreakdown):MoneyBreakdown {
  return {
    principal:a.principal+b.principal, interest:a.interest+b.interest, fee:a.fee+b.fee,
    penalty:a.penalty+b.penalty, unlockFee:a.unlockFee+b.unlockFee, discount:a.discount+b.discount,
    overpaid:a.overpaid+b.overpaid, badDebt:a.badDebt+b.badDebt,
    badDebtInstallment:a.badDebtInstallment+b.badDebtInstallment, total:a.total+b.total,
  };
}
function bucketPillClasses(b:string):string {
  const m:Record<string,string>={
    "ปกติ":"bg-green-100 text-green-800 border-green-300",
    "เกิน 1-7":"bg-yellow-100 text-yellow-800 border-yellow-300",
    "เกิน 8-14":"bg-amber-100 text-amber-800 border-amber-300",
    "เกิน 15-30":"bg-orange-100 text-orange-800 border-orange-300",
    "เกิน 31-60":"bg-red-200 text-red-800 border-red-400",
    "เกิน 61-90":"bg-red-300 text-red-900 border-red-500",
    "เกิน >90":"bg-rose-700 text-white border-rose-800",
    "ระงับสัญญา":"bg-gray-800 text-white border-gray-900",
    "สิ้นสุดสัญญา":"bg-blue-100 text-blue-800 border-blue-300",
    "หนี้เสีย":"bg-gray-700 text-white border-gray-800",
    "ยกเลิกสัญญา":"bg-red-100 text-red-800 border-red-300",
  };
  return m[b]??"bg-gray-100 text-gray-700 border-gray-200";
}
function bucketHeaderBg(b:string):string {
  const m:Record<string,string>={
    "ปกติ":"bg-green-700","เกิน 1-7":"bg-yellow-600","เกิน 8-14":"bg-amber-600",
    "เกิน 15-30":"bg-orange-600","เกิน 31-60":"bg-red-600","เกิน 61-90":"bg-red-700",
    "เกิน >90":"bg-rose-800","ระงับสัญญา":"bg-gray-700","สิ้นสุดสัญญา":"bg-blue-700","หนี้เสีย":"bg-gray-800","ยกเลิกสัญญา":"bg-red-700",
  };
  return m[b]??"bg-slate-600";
}
function bucketCellBg(b:string):string {
  const m:Record<string,string>={
    "ปกติ":"bg-green-50/40","เกิน 1-7":"bg-yellow-50/40","เกิน 8-14":"bg-amber-50/40",
    "เกิน 15-30":"bg-orange-50/40","เกิน 31-60":"bg-red-50/40","เกิน 61-90":"bg-red-100/40",
    "เกิน >90":"bg-rose-100/40","ระงับสัญญา":"bg-gray-100/40","สิ้นสุดสัญญา":"bg-blue-50/40","หนี้เสีย":"bg-gray-200/40","ยกเลิกสัญญา":"bg-red-50/40",
  };
  return m[b]??"";
}
function fmtMoney(n:number|null|undefined):string {
  if(n==null||Number.isNaN(Number(n)))return"—";
  const num=Number(n);
  if(num===0)return"0.00";
  return num.toLocaleString("th-TH",{minimumFractionDigits:2,maximumFractionDigits:2});
}
function fmtMonthYear(ym:string|undefined|null):string {
  if(!ym||typeof ym!=="string"||!ym.includes("-"))return ym??"";
  const[y,m]=ym.split("-");
  const MONTHS=["ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];
  return`${MONTHS[parseInt(m,10)-1]??m} ${(parseInt(y,10)+543).toString().slice(-2)}`;
}

// ─── Sub-components ───────────────────────────────────────────────────────────
function MonthMultiSelect({selected,onChange,options}:{selected:Set<string>;onChange:(v:Set<string>)=>void;options:string[]}) {
  const[open,setOpen]=useState(false);
  const toggle=(s:string)=>{const n=new Set(selected);if(n.has(s))n.delete(s);else n.add(s);onChange(n);};
  const labelText=selected.size===0?"ทุกเดือน":selected.size===1?fmtMonthYear(Array.from(selected)[0]):`${selected.size} เดือน`;
  return(
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={`flex items-center gap-1.5 h-9 px-3 py-2 rounded-md border text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-[140px] justify-between ${selected.size>0?"border-indigo-400 bg-indigo-50 text-indigo-800 font-medium":"border-gray-200 bg-white text-gray-700 hover:bg-gray-50"}`}>
          <CalendarDays className="w-3.5 h-3.5 flex-shrink-0 text-gray-400"/>
          <span className="truncate flex-1 text-left">{labelText}</span>
          <ChevronsUpDown className="w-3.5 h-3.5 flex-shrink-0 text-gray-400"/>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-52 p-0" align="start">
        <Command>
          <CommandList>
            <CommandEmpty>ไม่มีข้อมูล</CommandEmpty>
            <CommandGroup>
              <CommandItem value="__all__" onSelect={()=>{onChange(new Set());setOpen(false);}}>
                <Check className={`mr-2 h-3.5 w-3.5 ${selected.size===0?"opacity-100 text-indigo-600":"opacity-0"}`}/>
                <span className={selected.size===0?"text-indigo-600 font-medium":"text-gray-500"}>ทุกเดือน</span>
              </CommandItem>
              {options.map((opt)=>(
                <CommandItem key={opt} value={opt} onSelect={()=>toggle(opt)}>
                  <Check className={`mr-2 h-3.5 w-3.5 ${selected.has(opt)?"opacity-100 text-indigo-600":"opacity-0"}`}/>
                  {fmtMonthYear(opt)}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function MultiSelectFilter({label,selected,onChange,options,placeholder="ทั้งหมด"}:{label:string;selected:Set<string>;onChange:(v:Set<string>)=>void;options:string[];placeholder?:string}) {
  const[open,setOpen]=useState(false);
  const toggle=(s:string)=>{const n=new Set(selected);if(n.has(s))n.delete(s);else n.add(s);onChange(n);};
  const labelText=selected.size===0?placeholder:selected.size===1?Array.from(selected)[0]:`${selected.size} รายการ`;
  return(
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={`flex items-center gap-1.5 h-9 px-3 py-2 rounded-md border text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-[140px] justify-between ${selected.size>0?"border-indigo-400 bg-indigo-50 text-indigo-800 font-medium":"border-gray-200 bg-white text-gray-700 hover:bg-gray-50"}`}>
          <span className="truncate">{labelText}</span>
          <ChevronsUpDown className="w-3.5 h-3.5 flex-shrink-0 text-gray-400"/>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-60 p-0" align="start">
        <Command>
          <CommandInput placeholder={`ค้นหา ${label}...`} className="h-8 text-sm"/>
          <CommandList>
            <CommandEmpty>ไม่พบตัวเลือก</CommandEmpty>
            <CommandGroup>
              <CommandItem value="__all__" onSelect={()=>{onChange(new Set());setOpen(false);}}>
                <Check className={`mr-2 h-3.5 w-3.5 ${selected.size===0?"opacity-100 text-indigo-600":"opacity-0"}`}/>
                <span className={selected.size===0?"text-indigo-600 font-medium":"text-gray-500"}>{placeholder}</span>
              </CommandItem>
              {options.map((opt)=>(
                <CommandItem key={opt} value={opt} onSelect={(v)=>{const o=options.find((x)=>x.toLowerCase()===v)??v;toggle(o);}}>
                  <Check className={`mr-2 h-3.5 w-3.5 ${selected.has(opt)?"opacity-100 text-indigo-600":"opacity-0"}`}/>
                  {opt}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// ─── TabInfoPopup ────────────────────────────────────────────────────────────────────────────────────
// อธิบายความหมายของแต่ละแถบ (tab) ในสรุปรายเดือน
const TAB_INFO_CONTENT: {title:string;items:{label:string;desc:string;color?:string}[]} = {
  title: "สรุปรายเดือน — ความหมายของแต่ละแถบ",
  items: [
    {label:"สัญญา",    desc:"จำนวนสัญญาทั้งหมดที่อนุมัติ จัดกลุ่มตามสถานะหนี้ปัจจุบัน (ปกติ / เกินกำหนด / ระงับ / สิ้นสุด / หนี้เสีย)",color:"text-slate-700"},
    {label:"ยอดผ่อนรวม",     desc:"ยอดที่ลูกค้าต้องผ่อนทั้งหมด = SUM(net_amount) ทุกงวดตั้งแต่งวดแรกถึงงวดสุดท้าย (เงินต้น + ดอกเบี้ย + ค่าดำเนินการ ไม่รวมค่าปรับ/ค่าปลดล็อก) เช่น ผ่อนงวดละ 2,000 × 12 งวด = 24,000",color:"text-purple-700"},
    {label:"เป้าเก็บหนี้",     desc:"ยอดค่างวด (เงินต้น + ดอกเบี้ย + ค่าดำเนินการ + ค่าปรับ + ค่าปลดล็อก) ตั้งแต่งวดแรกถึงงวดปัจจุบัน (เฉพาะงวดที่ถึงกำหนดแล้ว)",color:"text-indigo-700"},
    {label:"ยอดเก็บหนี้",      desc:"ยอดเงินที่ลูกค้าชำระจริง แยกตามประเภท (เงินต้น / ดอกเบี้ย / ค่าดำเนินการ / ค่าปรับ / ค่าปลดล็อก / ชำระเกิน / หนี้เสีย)",color:"text-green-700"},
    {label:"หนี้ค้างชำระ",   desc:"ยอดค้างชำระจากงวดก่อนหน้าจนถึงงวดปัจจุบัน + (ค่าปรับ + ค่าปลดล็อกของงวดล่าสุด) ไม่รวมยอดที่ชำระเข้ามาแล้ว",color:"text-orange-700"},
    {label:"ยังไม่ถึงกำหนด", desc:"ยอดค่างวด (เฉพาะเงินต้น + ดอกเบี้ย + ค่าดำเนินการ ไม่รวมค่าปรับ/ค่าปลดล็อก) ของงวดที่ยังไม่ถึงกำหนดชำระ",color:"text-blue-700"},
  ],
};

function TabInfoPopup() {
  return(
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="flex items-center justify-center w-7 h-7 rounded-full bg-slate-500 hover:bg-slate-400 text-white transition-colors flex-shrink-0" title="ความหมายของแต่ละแถบ">
          <Info className="w-3.5 h-3.5"/>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-3" align="end">
        <p className="text-xs font-semibold text-gray-800 mb-2.5">{TAB_INFO_CONTENT.title}</p>
        <div className="space-y-2.5">
          {TAB_INFO_CONTENT.items.map((item)=>(
            <div key={item.label} className="flex gap-2">
              <span className={`text-xs font-semibold whitespace-nowrap min-w-[110px] ${item.color??"text-gray-700"}`}>{item.label}</span>
              <span className="text-xs text-gray-600 leading-relaxed">{item.desc}</span>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ─── InfoPopup (per-tab column descriptions) ─────────────────────────────────
const INFO_CONTENT: Record<string,{title:string;items:{label:string;desc:string}[]}> = {
  count: {
    title: "จำนวนสัญญา — ที่มาของตัวเลขในคอลัมน์",
    items: [
      {label:"เดือน-ปีที่อนุมัติ",desc:"เดือนและปีที่อนุมัติสัญญา (จัดกลุ่มตามวันอนุมัติ)"},
      {label:"สัญญา",desc:"จำนวนสัญญาทั้งหมดที่อนุมัติในเดือนนั้น"},
      {label:"ปกติ",desc:"สัญญาที่ไม่มีวันค้างชำระ (ค้างชำระ 0 วัน)"},
      {label:"เกิน 1-7",desc:"สัญญาที่ค้างชำระ 1–7 วัน"},
      {label:"เกิน 8-14",desc:"สัญญาที่ค้างชำระ 8–14 วัน"},
      {label:"เกิน 15-30",desc:"สัญญาที่ค้างชำระ 15–30 วัน"},
      {label:"เกิน 31-60",desc:"สัญญาที่ค้างชำระ 31–60 วัน"},
      {label:"เกิน 61-90",desc:"สัญญาที่ค้างชำระ 61–90 วัน (สงสัยจะเสีย)"},
      {label:"เกิน >90",desc:"สัญญาที่ค้างชำระมากกว่า 90 วัน (สงสัยจะเสีย)"},
      {label:"ระงับสัญญา",desc:"สัญญาที่ถูกระงับการชำระชั่วคราว"},
      {label:"สิ้นสุดสัญญา",desc:"สัญญาที่สิ้นสุดอายุสัญญาแล้ว"},
      {label:"หนี้เสีย",desc:"สัญญาที่ถูกจัดเป็นหนี้เสีย"},
    ]
  },
  target: {
    title: "ยอดที่ต้องชำระ — ที่มาของตัวเลขในคอลัมน์",
    items: [
      {label:"เดือน-ปีที่อนุมัติ",desc:"เดือนและปีที่อนุมัติสัญญา"},
      {label:"ยอดที่ต้องชำระ",desc:"ยอดเป้าเก็บหนี้ที่ต้องชำระในเดือนนั้นๆ (รวมทุกรายการ)"},
      {label:"ปกติ",desc:"เป้าเก็บหนี้ของสัญญาที่ไม่ค้างชำระ"},
      {label:"เกิน 1-7",desc:"เป้าเก็บหนี้ของสัญญาที่ค้างชำระ 1–7 วัน"},
      {label:"เกิน 8-14",desc:"เป้าเก็บหนี้ของสัญญาที่ค้างชำระ 8–14 วัน"},
      {label:"เกิน 15-30",desc:"เป้าเก็บหนี้ของสัญญาที่ค้างชำระ 15–30 วัน"},
      {label:"เกิน 31-60",desc:"เป้าเก็บหนี้ของสัญญาที่ค้างชำระ 31–60 วัน"},
      {label:"เกิน 61-90",desc:"เป้าเก็บหนี้ของสัญญาที่ค้างชำระ 61–90 วัน"},
      {label:"เกิน >90",desc:"เป้าเก็บหนี้ของสัญญาที่ค้างชำระมากกว่า 90 วัน"},
      {label:"ระงับสัญญา",desc:"เป้าเก็บหนี้ของสัญญาที่ถูกระงับชั่วคราว"},
      {label:"สิ้นสุดสัญญา",desc:"เป้าเก็บหนี้ของสัญญาที่สิ้นสุดอายุแล้ว"},
      {label:"หนี้เสีย",desc:"เป้าเก็บหนี้ของสัญญาที่ถูกจัดเป็นหนี้เสีย"},
    ]
  },
  paid: {
    title: "ยอดเก็บหนี้ — ที่มาของตัวเลขในคอลัมน์",
    items: [
      {label:"เดือน-ปีที่อนุมัติ",desc:"เดือนและปีที่อนุมัติสัญญา"},
      {label:"ยอดชำระ",desc:"ยอดเงินที่ชำระจริงในเดือนนั้นๆ (รวมทุกรายการ)"},
      {label:"ปกติ",desc:"ยอดชำระจากสัญญาที่ไม่ค้างชำระ (นับตามสถานะ ณ วันที่ชำระ)"},
      {label:"เกิน 1-7",desc:"ยอดชำระจากสัญญาที่ค้างชำระ 1–7 วัน"},
      {label:"เกิน 8-14",desc:"ยอดชำระจากสัญญาที่ค้างชำระ 8–14 วัน"},
      {label:"เกิน 15-30",desc:"ยอดชำระจากสัญญาที่ค้างชำระ 15–30 วัน"},
      {label:"เกิน 31-60",desc:"ยอดชำระจากสัญญาที่ค้างชำระ 31–60 วัน"},
      {label:"เกิน 61-90",desc:"ยอดชำระจากสัญญาที่ค้างชำระ 61–90 วัน"},
      {label:"เกิน >90",desc:"ยอดชำระจากสัญญาที่ค้างชำระมากกว่า 90 วัน"},
      {label:"หนี้เสีย (ค่างวด)",desc:"ยอดชำระปกติ (ไม่รวมยอดขายเครื่อง) จากสัญญาหนี้เสีย"},
      {label:"หนี้เสีย (ขายเครื่อง)",desc:"ยอดขายเครื่องที่บันทึกแยกไว้สำหรับสัญญาหนี้เสีย"},
    ]
  },
  due: {
    title: "ยอดค้างชำระ — ที่มาของตัวเลขในคอลัมน์",
    items: [
      {label:"เดือน-ปีที่อนุมัติ",desc:"เดือนและปีที่อนุมัติสัญญา"},
      {label:"ยอดค้างชำระ",desc:"ยอดหนี้ที่ยังค้างอยู่ = เป้าเก็บ − ชำระแล้ว"},
      {label:"ปกติ",desc:"ยอดค้างชำระของสัญญาที่ไม่ค้างชำระ"},
      {label:"เกิน 1-7",desc:"ยอดค้างชำระของสัญญาที่ค้างชำระ 1–7 วัน"},
      {label:"เกิน 8-14",desc:"ยอดค้างชำระของสัญญาที่ค้างชำระ 8–14 วัน"},
      {label:"เกิน 15-30",desc:"ยอดค้างชำระของสัญญาที่ค้างชำระ 15–30 วัน"},
      {label:"เกิน 31-60",desc:"ยอดค้างชำระของสัญญาที่ค้างชำระ 31–60 วัน"},
      {label:"เกิน 61-90",desc:"ยอดค้างชำระของสัญญาที่ค้างชำระ 61–90 วัน"},
      {label:"เกิน >90",desc:"ยอดค้างชำระของสัญญาที่ค้างชำระมากกว่า 90 วัน"},
      {label:"ระงับสัญญา",desc:"ยอดค้างชำระของสัญญาที่ถูกระงับชั่วคราว"},
    ]
  },
  notYetDue: {
    title: "ยอดที่ยังไม่ถึงกำหนด — ที่มาของตัวเลขในคอลัมน์",
    items: [
      {label:"เดือน-ปีที่อนุมัติ",desc:"เดือนและปีที่อนุมัติสัญญา"},
      {label:"ยอดที่ยังไม่ถึงกำหนด",desc:"ยอดเป้าเก็บหนี้ของงวดที่ due_date > วันนี้ (ยังไม่ถึงกำหนดชำระ)"},
      {label:"ปกติ",desc:"ยอดงวดอนาคตของสัญญาที่ไม่ค้างชำระ"},
      {label:"เกิน 1-7",desc:"ยอดงวดอนาคตของสัญญาที่ค้างชำระ 1–7 วัน"},
      {label:"เกิน 8-14",desc:"ยอดงวดอนาคตของสัญญาที่ค้างชำระ 8–14 วัน"},
      {label:"เกิน 15-30",desc:"ยอดงวดอนาคตของสัญญาที่ค้างชำระ 15–30 วัน"},
      {label:"เกิน 31-60",desc:"ยอดงวดอนาคตของสัญญาที่ค้างชำระ 31–60 วัน"},
      {label:"เกิน 61-90",desc:"ยอดงวดอนาคตของสัญญาที่ค้างชำระ 61–90 วัน"},
      {label:"เกิน >90",desc:"ยอดงวดอนาคตของสัญญาที่ค้างชำระมากกว่า 90 วัน"},
    ]
  },
};

function InfoPopup({tab}:{tab:string}) {
  const info=INFO_CONTENT[tab];
  if(!info)return null;
  return(
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="flex items-center justify-center w-7 h-7 rounded-full bg-slate-600 hover:bg-slate-500 text-white transition-colors" title="ที่มาของตัวเลข">
          <Info className="w-3.5 h-3.5"/>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-3" align="end">
        <p className="text-xs font-semibold text-gray-800 mb-2">{info.title} — ที่มาของตัวเลข</p>
        <div className="space-y-1.5">
          {info.items.map((item)=>(
            <div key={item.label} className="flex gap-2">
              <span className="text-xs font-medium text-indigo-700 whitespace-nowrap min-w-[80px]">{item.label}</span>
              <span className="text-xs text-gray-600">{item.desc}</span>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ─── YearMultiSelect ─────────────────────────────────────────────────────────
function YearMultiSelect({selected,onChange,options}:{selected:Set<string>;onChange:(v:Set<string>)=>void;options:string[]}) {
  const[open,setOpen]=useState(false);
  const toggle=(s:string)=>{const n=new Set(selected);if(n.has(s))n.delete(s);else n.add(s);onChange(n);};
  const labelText=selected.size===0?"ทุกปี":selected.size===1?`ปี ${(parseInt(Array.from(selected)[0],10)+543).toString().slice(-2)}`:`${selected.size} ปี`;
  return(
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={`flex items-center gap-1.5 h-9 px-3 py-2 rounded-md border text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-[110px] justify-between ${selected.size>0?"border-indigo-400 bg-indigo-50 text-indigo-800 font-medium":"border-gray-200 bg-white text-gray-700 hover:bg-gray-50"}`}>
          <span className="truncate flex-1 text-left">{labelText}</span>
          <ChevronsUpDown className="w-3.5 h-3.5 flex-shrink-0 text-gray-400"/>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-44 p-0" align="start">
        <Command>
          <CommandList>
            <CommandEmpty>ไม่มีข้อมูล</CommandEmpty>
            <CommandGroup>
              <CommandItem value="__all__" onSelect={()=>{onChange(new Set());setOpen(false);}}>
                <Check className={`mr-2 h-3.5 w-3.5 ${selected.size===0?"opacity-100 text-indigo-600":"opacity-0"}`}/>
                <span className={selected.size===0?"text-indigo-600 font-medium":"text-gray-500"}>ทุกปี</span>
              </CommandItem>
              {options.map((opt)=>(
                <CommandItem key={opt} value={opt} onSelect={()=>toggle(opt)}>
                  <Check className={`mr-2 h-3.5 w-3.5 ${selected.has(opt)?"opacity-100 text-indigo-600":"opacity-0"}`}/>
                  ปี {(parseInt(opt,10)+543).toString().slice(-2)}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function DeviceFamilyFilter({value,onChange}:{value:string;onChange:(v:string)=>void}) {
  return(
    <div className="flex items-center gap-1 rounded-md border border-gray-200 bg-white overflow-hidden h-9">
      <button type="button" onClick={()=>onChange(value==="iOS"?"":"iOS")}
        className={`flex items-center gap-1 px-2.5 h-full text-xs font-medium transition-colors ${value==="iOS"?"bg-blue-600 text-white":"text-gray-600 hover:bg-gray-50"}`}>
        <Smartphone className="w-3.5 h-3.5"/>iOS
      </button>
      <div className="w-px h-5 bg-gray-200"/>
      <button type="button" onClick={()=>onChange(value==="Android"?"":"Android")}
        className={`flex items-center gap-1 px-2.5 h-full text-xs font-medium transition-colors ${value==="Android"?"bg-green-600 text-white":"text-gray-600 hover:bg-gray-50"}`}>
        <Smartphone className="w-3.5 h-3.5"/>Android
      </button>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function MonthlySummary() {
  const{can,isSuperAdmin}=useAppAuth();const{section}=useSection();const{setActions}=useNavActions();
  const canView=can("debt_report","view");const canExport=can("debt_report","export");
  const[tab,setTab]=useState<TabKey>("count");

  // ── Repopulate Monthly Summary Cache (superAdmin only) ────────────────────
  const[isRepopulating,setIsRepopulating]=useState(false);
  const handleRepopulateMonthlySummary=useCallback(async()=>{
    if(!section||isRepopulating)return;
    setIsRepopulating(true);
    try{
      const res=await fetch("/api/internal/repopulate-monthly-summary",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({section,async:true}),
      });
      const data=await res.json();
      if(data.ok){
        toast.success(`เริ่ม Repopulate Monthly Summary (${section}) แล้ว — กำลังประมวลผลในพื้นหลัง`);
      }else{
        toast.error(`Repopulate ล้มเหลว: ${data.error??"Unknown error"}`);
      }
    }catch(err:any){
      toast.error(`Repopulate ล้มเหลว: ${err?.message??"Network error"}`);
    }finally{
      setIsRepopulating(false);
    }
  },[section,isRepopulating]);

  // ── filter state ─────────────────────────────────────────────────────────
  // Tab 1: จำนวนสัญญา
  const[countApproveDate,setCountApproveDate]=useState("");
  const[countApproveMonths,setCountApproveMonths]=useState<Set<string>>(new Set());
  const[countApproveYears,setCountApproveYears]=useState<Set<string>>(new Set());
  const[countProductType,setCountProductType]=useState<Set<string>>(new Set());
  const[countDeviceFamily,setCountDeviceFamily]=useState("");

  // Tab installTotal: ยอดผ่อนรวม
  const[installApproveMonths,setInstallApproveMonths]=useState<Set<string>>(new Set());
  const[installApproveYears,setInstallApproveYears]=useState<Set<string>>(new Set());
  const[installProductType,setInstallProductType]=useState<Set<string>>(new Set());
  const[installDeviceFamily,setInstallDeviceFamily]=useState("");

  // Tab 2: ยอดที่ต้องชำระ
  const[targetDueDate,setTargetDueDate]=useState("");
  const[targetDueMonths,setTargetDueMonths]=useState<Set<string>>(new Set());
  const[targetApproveMonths,setTargetApproveMonths]=useState<Set<string>>(new Set());
  const[targetApproveYears,setTargetApproveYears]=useState<Set<string>>(new Set());
  const[targetProductType,setTargetProductType]=useState<Set<string>>(new Set());
  const[targetDeviceFamily,setTargetDeviceFamily]=useState("");

  // Tab 3: ยอดชำระแล้ว
  const[paidAtDate,setPaidAtDate]=useState("");
  const[paidAtMonths,setPaidAtMonths]=useState<Set<string>>(new Set());
  const[paidProductType,setPaidProductType]=useState<Set<string>>(new Set());
  const[paidDeviceFamily,setPaidDeviceFamily]=useState("");

  // Tab 4: ยอดค้างชำระ
  const[dueAtDate,setDueAtDate]=useState("");
  const[dueAtMonths,setDueAtMonths]=useState<Set<string>>(new Set());
  const[dueProductType,setDueProductType]=useState<Set<string>>(new Set());
  const[dueDeviceFamily,setDueDeviceFamily]=useState("");

  // Tab 5: ยอดที่ยังไม่ถึงกำหนด
  const[notYetDueDueDate,setNotYetDueDueDate]=useState("");
  const[notYetDueDueMonths,setNotYetDueDueMonths]=useState<Set<string>>(new Set());
  const[notYetDueApproveMonths,setNotYetDueApproveMonths]=useState<Set<string>>(new Set());
  const[notYetDueApproveYears,setNotYetDueApproveYears]=useState<Set<string>>(new Set());
  const[notYetDueProductType,setNotYetDueProductType]=useState<Set<string>>(new Set());
  const[notYetDueDeviceFamily,setNotYetDueDeviceFamily]=useState("");

  const headerRef=useRef<HTMLDivElement>(null);
  const[headerH,setHeaderH]=useState(96);
  useEffect(()=>{
    const el=headerRef.current;if(!el)return;
    const ro=new ResizeObserver(()=>setHeaderH(el.offsetHeight));
    ro.observe(el);setHeaderH(el.offsetHeight);
    return()=>ro.disconnect();
  },[]);

  // badge visibility
  const[installVis,setInstallVis]=useState<Record<"principal"|"interest"|"fee",boolean>>({principal:true,interest:true,fee:true});
  const[paidVis,setPaidVis]=useState<Record<MoneyBadgeKey,boolean>>({principal:true,interest:true,fee:true,penalty:true,unlockFee:true,discount:false,overpaid:true,badDebtInstallment:true});
  const[targetVis,setTargetVis]=useState<Record<MoneyBadgeKey,boolean>>({principal:true,interest:true,fee:true,penalty:false,unlockFee:false,discount:false,overpaid:false,badDebtInstallment:false});
  const[dueVis,setDueVis]=useState<Record<DueBadgeKey,boolean>>({principal:true,interest:true,fee:true,penalty:true,unlockFee:true});
  const[notYetDueVis,setNotYetDueVis]=useState<Record<NotYetDueBadgeKey,boolean>>({principal:true,interest:true,fee:true});

  // bad debt sub-col toggles
  const[showBadDebtInstall,setShowBadDebtInstall]=useState(true);
  const[showBadDebtSale,setShowBadDebtSale]=useState(true);

  // combined tab: badge expand state (ซ่อนไว้ก่อน กดขยายได้ต่อแถบ)
  const[combinedBadgeExpanded,setCombinedBadgeExpanded]=useState<Set<TabKey>>(new Set());
  // combined tab: filter state
  const[combinedApproveMonths,setCombinedApproveMonths]=useState<Set<string>>(new Set());
  const[combinedApproveYears,setCombinedApproveYears]=useState<Set<string>>(new Set());
  const[combinedProductType,setCombinedProductType]=useState<Set<string>>(new Set());
  const[combinedDeviceFamily,setCombinedDeviceFamily]=useState("");

  // combined view mode: สถานะหนี้ (bucket) หรือ เดือนที่ต้องชำระ
  const[combinedViewMode,setCombinedViewMode]=useState<"bucket"|"dueMonth">("bucket");
  // combined sub-row toggle (เปิด/ปิดแต่ละแถบ ใน combined table)
  const[hiddenSubRows,setHiddenSubRows]=useState<Set<TabKey>>(new Set());
  const toggleSubRow=useCallback((key:TabKey)=>{setHiddenSubRows((p)=>{const n=new Set(p);if(n.has(key))n.delete(key);else n.add(key);return n;});},[]);
  // bucket eye toggle
  const[hiddenBuckets,setHiddenBuckets]=useState<Set<string>>(new Set());
  const toggleBucket=useCallback((b:string)=>{setHiddenBuckets((p)=>{const n=new Set(p);if(n.has(b))n.delete(b);else n.add(b);return n;});},[]);
  const toggleGroup=useCallback((g:ColGroup)=>{setHiddenBuckets((p)=>{const n=new Set(p);const allH=g.buckets.every((b)=>n.has(b));if(allH)g.buckets.forEach((b)=>n.delete(b));else g.buckets.forEach((b)=>n.add(b));return n;});},[]);
  const toggleAll=useCallback(()=>{setHiddenBuckets((p)=>{if(p.size===DEBT_BUCKETS.length)return new Set();return new Set(DEBT_BUCKETS);});},[]);
  const[hiddenRows,setHiddenRows]=useState<Set<string>>(new Set());
  const toggleRow=useCallback((month:string)=>{setHiddenRows((p)=>{const n=new Set(p);if(n.has(month))n.delete(month);else n.add(month);return n;});},[]);

  const[sortDir,setSortDir]=useState<SortDir>("asc");

  // ── search state (debounced) ───────────────────────────────────────────────────────────────────────────────────
  const[searchInput,setSearchInput]=useState("");
  const[search,setSearch]=useState("");
  // debounce search 400ms
  useEffect(()=>{
    const t=setTimeout(()=>setSearch(searchInput.trim()),400);
    return()=>clearTimeout(t);
  },[searchInput]);

  // ── query input ───────────────────────────────────────────────────────────────────────────────────
  const queryInput=useMemo(()=>{
    if(!section)return null;
    return{
      section,
      // count
      countApproveDate:countApproveDate||undefined,
      countApproveMonths:countApproveMonths.size>0?Array.from(countApproveMonths):undefined,
      countProductType:countProductType.size===1?Array.from(countProductType)[0]:undefined,
      countDeviceFamily:(countDeviceFamily as "iOS"|"Android"|undefined)||undefined,
      // installTotal
      installTotalApproveMonths:installApproveMonths.size>0?Array.from(installApproveMonths):undefined,
      installTotalProductType:installProductType.size===1?Array.from(installProductType)[0]:undefined,
      installTotalDeviceFamily:(installDeviceFamily as "iOS"|"Android"|undefined)||undefined,
      // target
      targetDueDate:targetDueDate||undefined,
      targetDueMonths:targetDueMonths.size>0?Array.from(targetDueMonths):undefined,
      targetApproveMonths:targetApproveMonths.size>0?Array.from(targetApproveMonths):undefined,
      targetProductType:targetProductType.size===1?Array.from(targetProductType)[0]:undefined,
      targetDeviceFamily:(targetDeviceFamily as "iOS"|"Android"|undefined)||undefined,
      // paid
      paidAtDate:paidAtDate||undefined,
      paidAtMonths:paidAtMonths.size>0?Array.from(paidAtMonths):undefined,
      paidProductType:paidProductType.size===1?Array.from(paidProductType)[0]:undefined,
      paidDeviceFamily:(paidDeviceFamily as "iOS"|"Android"|undefined)||undefined,
      // due
      dueAtDate:dueAtDate||undefined,
      dueAtMonths:dueAtMonths.size>0?Array.from(dueAtMonths):undefined,
      dueProductType:dueProductType.size===1?Array.from(dueProductType)[0]:undefined,
      dueDeviceFamily:(dueDeviceFamily as "iOS"|"Android"|undefined)||undefined,
      // notYetDue
      notYetDueDueDate:notYetDueDueDate||undefined,
      notYetDueDueMonths:notYetDueDueMonths.size>0?Array.from(notYetDueDueMonths):undefined,
      notYetDueApproveMonths:notYetDueApproveMonths.size>0?Array.from(notYetDueApproveMonths):undefined,
      notYetDueProductType:notYetDueProductType.size===1?Array.from(notYetDueProductType)[0]:undefined,
      notYetDueDeviceFamily:(notYetDueDeviceFamily as "iOS"|"Android"|undefined)||undefined,
      // global search
      search:search||undefined,
    };
  },[section,
    countApproveDate,countApproveMonths,countProductType,countDeviceFamily,
    installApproveMonths,installProductType,installDeviceFamily,
    targetDueDate,targetDueMonths,targetApproveMonths,targetProductType,targetDeviceFamily,
    paidAtDate,paidAtMonths,paidProductType,paidDeviceFamily,
    dueAtDate,dueAtMonths,dueProductType,dueDeviceFamily,
    notYetDueDueDate,notYetDueDueMonths,notYetDueApproveMonths,notYetDueProductType,notYetDueDeviceFamily,
    search,
  ]);

  const query=trpc.monthlySummary.get.useQuery(queryInput as any,{enabled:canView&&!!queryInput});

  // due month query — เรียกเมื่อ tab=combined และ viewMode=dueMonth
  const dueMonthQueryInput=useMemo(()=>{
    if(!section||tab!=="combined"||combinedViewMode!=="dueMonth")return null;
    return{
      section,
      approveMonths:combinedApproveMonths.size>0?Array.from(combinedApproveMonths):undefined,
      productType:combinedProductType.size===1?Array.from(combinedProductType)[0]:undefined,
      deviceFamily:(combinedDeviceFamily as "iOS"|"Android"|undefined)||undefined,
    };
  },[section,tab,combinedViewMode,combinedApproveMonths,combinedProductType,combinedDeviceFamily]);
  const dueMonthQuery=trpc.monthlySummary.getDueMonthSummary.useQuery(dueMonthQueryInput as any,{enabled:canView&&!!dueMonthQueryInput});
  // parse dueMonth rows
  type FlatDueMonthRow={approveMonth:string;dueMonth:string;contractCount:number;paidTotal:number;paidPrincipal:number;paidInterest:number;paidFee:number;paidPenalty:number;paidUnlockFee:number;paidDiscount:number;paidOverpaid:number;paidBadDebt:number;paidBadDebtInstallment:number;targetTotal:number;targetPrincipal:number;targetInterest:number;targetFee:number;targetPenalty:number;targetUnlockFee:number;dueTotal:number;duePrincipal:number;dueInterest:number;dueFee:number;duePenalty:number;dueUnlockFee:number;notYetDueTotal:number;notYetDuePrincipal:number;notYetDueInterest:number;notYetDueFee:number;notYetDuePenalty:number;notYetDueUnlockFee:number;installTotalTotal:number;installTotalPrincipal:number;installTotalInterest:number;installTotalFee:number;};
  type DueMonthCell={contractCount:number;paid:MoneyBreakdown;target:MoneyBreakdown;due:MoneyBreakdown;notYetDue:MoneyBreakdown;installTotal:MoneyBreakdown;};
  type DueMonthRow={approveMonth:string;dueMonths:Record<string,DueMonthCell>;totalCount:number;approvedCount:number;totalPaid:MoneyBreakdown;totalTarget:MoneyBreakdown;totalDue:MoneyBreakdown;totalNotYetDue:MoneyBreakdown;totalInstallTotal:MoneyBreakdown;};
  const allDueMonths:string[]=(dueMonthQuery.data?.allDueMonths??[]) as string[];
  const dueMonthRows=useMemo(()=>{
    try{
      const flat:FlatDueMonthRow[]=JSON.parse((dueMonthQuery.data?.rowsJson??"[]") as string);
      const monthMap=new Map<string,DueMonthRow>();
      for(const fr of flat){
        if(!fr||!fr.approveMonth)continue;
        if(fr.dueMonth==="__total__"){
          const row=monthMap.get(fr.approveMonth);if(!row)continue;
          row.approvedCount=fr.contractCount; // จำนวนสัญญาที่อนุมัติ
          row.totalCount=fr.contractCount; // ยังคงไว้เพื่อ backward compat
          row.totalPaid={principal:fr.paidPrincipal??0,interest:fr.paidInterest??0,fee:fr.paidFee??0,penalty:fr.paidPenalty??0,unlockFee:fr.paidUnlockFee??0,discount:fr.paidDiscount??0,overpaid:fr.paidOverpaid??0,badDebt:fr.paidBadDebt??0,badDebtInstallment:fr.paidBadDebtInstallment??0,total:fr.paidTotal??0};
          row.totalTarget={principal:fr.targetPrincipal,interest:fr.targetInterest,fee:fr.targetFee,penalty:fr.targetPenalty,unlockFee:fr.targetUnlockFee,discount:0,overpaid:0,badDebt:0,badDebtInstallment:0,total:fr.targetTotal};
          row.totalDue={principal:fr.duePrincipal,interest:fr.dueInterest,fee:fr.dueFee,penalty:fr.duePenalty,unlockFee:fr.dueUnlockFee,discount:0,overpaid:0,badDebt:0,badDebtInstallment:0,total:fr.dueTotal};
          row.totalNotYetDue={principal:fr.notYetDuePrincipal,interest:fr.notYetDueInterest,fee:fr.notYetDueFee,penalty:fr.notYetDuePenalty,unlockFee:fr.notYetDueUnlockFee,discount:0,overpaid:0,badDebt:0,badDebtInstallment:0,total:fr.notYetDueTotal};
          row.totalInstallTotal={principal:fr.installTotalPrincipal,interest:fr.installTotalInterest,fee:fr.installTotalFee,penalty:0,unlockFee:0,discount:0,overpaid:0,badDebt:0,badDebtInstallment:0,total:fr.installTotalTotal};
          continue;
        }
        if(!monthMap.has(fr.approveMonth))monthMap.set(fr.approveMonth,{approveMonth:fr.approveMonth,dueMonths:{},totalCount:0,approvedCount:0,totalPaid:emptyMoney(),totalTarget:emptyMoney(),totalDue:emptyMoney(),totalNotYetDue:emptyMoney(),totalInstallTotal:emptyMoney()});
        const row=monthMap.get(fr.approveMonth)!;
        row.dueMonths[fr.dueMonth]={contractCount:fr.contractCount,paid:{principal:fr.paidPrincipal??0,interest:fr.paidInterest??0,fee:fr.paidFee??0,penalty:fr.paidPenalty??0,unlockFee:fr.paidUnlockFee??0,discount:fr.paidDiscount??0,overpaid:fr.paidOverpaid??0,badDebt:fr.paidBadDebt??0,badDebtInstallment:fr.paidBadDebtInstallment??0,total:fr.paidTotal??0},target:{principal:fr.targetPrincipal,interest:fr.targetInterest,fee:fr.targetFee,penalty:fr.targetPenalty,unlockFee:fr.targetUnlockFee,discount:0,overpaid:0,badDebt:0,badDebtInstallment:0,total:fr.targetTotal},due:{principal:fr.duePrincipal,interest:fr.dueInterest,fee:fr.dueFee,penalty:fr.duePenalty,unlockFee:fr.dueUnlockFee,discount:0,overpaid:0,badDebt:0,badDebtInstallment:0,total:fr.dueTotal},notYetDue:{principal:fr.notYetDuePrincipal,interest:fr.notYetDueInterest,fee:fr.notYetDueFee,penalty:fr.notYetDuePenalty,unlockFee:fr.notYetDueUnlockFee,discount:0,overpaid:0,badDebt:0,badDebtInstallment:0,total:fr.notYetDueTotal},installTotal:{principal:fr.installTotalPrincipal,interest:fr.installTotalInterest,fee:fr.installTotalFee,penalty:0,unlockFee:0,discount:0,overpaid:0,badDebt:0,badDebtInstallment:0,total:fr.installTotalTotal}};
      }
      return Array.from(monthMap.values()).sort((a,b)=>sortDir==="asc"?a.approveMonth.localeCompare(b.approveMonth):b.approveMonth.localeCompare(a.approveMonth));
    }catch{return[];}
  },[dueMonthQuery.data,sortDir]);

  const rowsJson:string=(query.data?.rowsJson??"[]") as string;
  const productTypes:string[]=(query.data?.productTypes??[]) as string[];
  const rawRows:SummaryRow[]=useMemo(()=>{
    try{const flat:FlatRow[]=JSON.parse(rowsJson);return groupFlatRows(flat);}catch{return[];}
  },[rowsJson]);

  const rows=useMemo(()=>{
    return [...rawRows].sort((a,b)=>sortDir==="asc"?a.approveMonth.localeCompare(b.approveMonth):b.approveMonth.localeCompare(a.approveMonth));
  },[rawRows,sortDir]);
  // combined tab: filtered rows (client-side filter by approveMonth/Year)
  const combinedRows=useMemo(()=>{
    return rows.filter((r)=>{
      if(combinedApproveMonths.size>0&&!combinedApproveMonths.has(r.approveMonth))return false;
      if(combinedApproveYears.size>0&&!combinedApproveYears.has(r.approveMonth.slice(0,4)))return false;
      return true;
    });
  },[rows,combinedApproveMonths,combinedApproveYears]);

  const availableMonths=useMemo(()=>rawRows.map((r)=>r.approveMonth).sort((a,b)=>b.localeCompare(a)),[rawRows]);
  const availableYears=useMemo(()=>{
    const yrs=new Set(rawRows.map((r)=>r.approveMonth.slice(0,4)));
    return Array.from(yrs).sort((a,b)=>b.localeCompare(a));
  },[rawRows]);

  // grand total
  const grandTotal=useMemo(()=>{
    const bt:Record<string,{count:number;paid:MoneyBreakdown;due:MoneyBreakdown;target:MoneyBreakdown;notYetDue:MoneyBreakdown;installTotal:MoneyBreakdown}>={};
    for(const b of DEBT_BUCKETS)bt[b]={count:0,paid:emptyMoney(),due:emptyMoney(),target:emptyMoney(),notYetDue:emptyMoney(),installTotal:emptyMoney()};
    let totalCount=0;
    const totalPaid=emptyMoney();const totalDue=emptyMoney();const totalTarget=emptyMoney();const totalNotYetDue=emptyMoney();const totalInstallTotal=emptyMoney();
    for(const row of rows){
      if(hiddenRows.has(row.approveMonth))continue;
      totalCount+=row.totalCount;
      for(const k of Object.keys(totalPaid)as(keyof MoneyBreakdown)[]){
        totalPaid[k]+=row.totalPaid[k];totalDue[k]+=row.totalDue[k];
        totalTarget[k]+=row.totalTarget[k];totalNotYetDue[k]+=row.totalNotYetDue[k];
        totalInstallTotal[k]+=(row.totalInstallTotal?.[k]??0);
      }
      for(const b of DEBT_BUCKETS){
        const cell=row.buckets[b];if(!cell)continue;
        bt[b].count+=cell.contractCount;
        for(const k of Object.keys(totalPaid)as(keyof MoneyBreakdown)[]){
          bt[b].paid[k]+=cell.paid[k];bt[b].due[k]+=cell.due[k];
          bt[b].target[k]+=cell.target[k];bt[b].notYetDue[k]+=cell.notYetDue[k];
          bt[b].installTotal[k]+=(cell.installTotal?.[k]??0);
        }
      }
    }
    return{bucketTotals:bt,totalCount,totalPaid,totalDue,totalTarget,totalNotYetDue,totalInstallTotal};
  },[rows,hiddenRows]);
  // combined grand total (คำนวณจาก combinedRows เท่านั้น)
  const combinedGrandTotal=useMemo(()=>{
    const bt:Record<string,{count:number;paid:MoneyBreakdown;due:MoneyBreakdown;target:MoneyBreakdown;notYetDue:MoneyBreakdown;installTotal:MoneyBreakdown}>={}
    for(const b of DEBT_BUCKETS)bt[b]={count:0,paid:emptyMoney(),due:emptyMoney(),target:emptyMoney(),notYetDue:emptyMoney(),installTotal:emptyMoney()};
    let totalCount=0;
    const totalPaid=emptyMoney();const totalDue=emptyMoney();const totalTarget=emptyMoney();const totalNotYetDue=emptyMoney();const totalInstallTotal=emptyMoney();
    for(const row of combinedRows){
      if(hiddenRows.has(row.approveMonth))continue;
      totalCount+=row.totalCount;
      for(const k of Object.keys(totalPaid)as(keyof MoneyBreakdown)[]){
        totalPaid[k]+=row.totalPaid[k];totalDue[k]+=row.totalDue[k];
        totalTarget[k]+=row.totalTarget[k];totalNotYetDue[k]+=row.totalNotYetDue[k];
        totalInstallTotal[k]+=(row.totalInstallTotal?.[k]??0);
      }
      for(const b of DEBT_BUCKETS){
        const cell=row.buckets[b];if(!cell)continue;
        bt[b].count+=cell.contractCount;
        for(const k of Object.keys(totalPaid)as(keyof MoneyBreakdown)[]){
          bt[b].paid[k]+=cell.paid[k];bt[b].due[k]+=cell.due[k];
          bt[b].target[k]+=cell.target[k];bt[b].notYetDue[k]+=cell.notYetDue[k];
          bt[b].installTotal[k]+=(cell.installTotal?.[k]??0);
        }
      }
    }
    return{bucketTotals:bt,totalCount,totalPaid,totalDue,totalTarget,totalNotYetDue,totalInstallTotal};
  },[combinedRows,hiddenRows]);

  const grandBadgePaid=useMemo(()=>{
    // Phase 141+ fix3: ใช้ grandTotal.totalPaid โดยตรง (queryPaid ไม่แยก bucket แล้ว)
    // totalPaid มาจาก __total__ row ที่ server ส่งมา ซึ่งถูกต้องแล้ว
    const tp=grandTotal.totalPaid;
    return{
      principal:paidVis.principal?(tp.principal??0):0,
      interest:paidVis.interest?(tp.interest??0):0,
      fee:paidVis.fee?(tp.fee??0):0,
      penalty:paidVis.penalty?(tp.penalty??0):0,
      unlockFee:paidVis.unlockFee?(tp.unlockFee??0):0,
      discount:tp.discount??0, // แสดงเสมอ ไม่ขึ้นกับ toggle (canToggle:false)
      overpaid:paidVis.overpaid?(tp.overpaid??0):0,
      badDebt:showBadDebtSale?(tp.badDebt??0):0,
      badDebtInstallment:paidVis.badDebtInstallment?(tp.badDebtInstallment??0):0,
      total:tp.total??0,
    };
  },[grandTotal,paidVis,showBadDebtSale]);
  const grandBadgeDue=useMemo(()=>{let r=emptyMoney();for(const b of DEBT_BUCKETS){const bt=grandTotal.bucketTotals[b];if(bt)r=addMoney(r,bt.due);}return r;},[grandTotal]);
  const grandBadgeTarget=useMemo(()=>{let r=emptyMoney();for(const b of DEBT_BUCKETS){const bt=grandTotal.bucketTotals[b];if(bt)r=addMoney(r,bt.target);}return r;},[grandTotal]);
  const grandBadgeNotYetDue=useMemo(()=>{let r=emptyMoney();for(const b of DEBT_BUCKETS){const bt=grandTotal.bucketTotals[b];if(bt)r=addMoney(r,bt.notYetDue);}return r;},[grandTotal]);
  const grandBadgeInstallTotal=useMemo(()=>{let r=emptyMoney();for(const b of DEBT_BUCKETS){const bt=grandTotal.bucketTotals[b];if(bt)r=addMoney(r,bt.installTotal);}return r;},[grandTotal]);
  // Phase 141+ fix3: ใช้ grandTotal.totalPaid โดยตรง (queryPaid ไม่แยก bucket แล้ว)
  const grandBadgePaidTotal=useMemo(()=>{
    const tp=grandTotal.totalPaid;
    return computeMoneyTotal(tp,paidVis)+(showBadDebtSale?(tp.badDebt??0):0);
  },[grandTotal,showBadDebtSale,paidVis]);

  // filter counts
  const countFilterCount=[search,countApproveDate,countApproveMonths.size>0,countApproveYears.size>0,countProductType.size>0,countDeviceFamily].filter(Boolean).length;
  const targetFilterCount=[search,targetDueDate,targetDueMonths.size>0,targetApproveMonths.size>0,targetApproveYears.size>0,targetProductType.size>0,targetDeviceFamily].filter(Boolean).length;
  const paidFilterCount=[search,paidAtDate,paidAtMonths.size>0,paidProductType.size>0,paidDeviceFamily].filter(Boolean).length;
  const dueFilterCount=[search,dueAtDate,dueAtMonths.size>0,dueProductType.size>0,dueDeviceFamily].filter(Boolean).length;
  const notYetDueFilterCount=[search,notYetDueDueDate,notYetDueDueMonths.size>0,notYetDueApproveMonths.size>0,notYetDueApproveYears.size>0,notYetDueProductType.size>0,notYetDueDeviceFamily].filter(Boolean).length;
  const installFilterCount=[search,installApproveMonths.size>0,installApproveYears.size>0,installProductType.size>0,installDeviceFamily].filter(Boolean).length;
  const activeFilterCount=tab==="count"?countFilterCount:tab==="installTotal"?installFilterCount:tab==="target"?targetFilterCount:tab==="paid"?paidFilterCount:tab==="due"?dueFilterCount:notYetDueFilterCount;

  // ── Export Excel ──────────────────────────────────────────────────────────
  const handleExport=useCallback(()=>{
    if(!canExport){toast.error("คุณไม่มีสิทธิ์ Export");return;}
    try{
      const wb=XLSX.utils.book_new();

      // ── helpers ──────────────────────────────────────────────────────────────
      // คำนวณค่า cell ตาม tab และ badge vis state
      const getCellVal=(b:string, cell:SummaryCell|undefined, t:TabKey):number=>{
        if(hiddenBuckets.has(b)||!cell)return 0;
        if(t==="count")return cell.contractCount;
        if(t==="installTotal")return (installVis.principal?cell.installTotal.principal:0)+(installVis.interest?cell.installTotal.interest:0)+(installVis.fee?cell.installTotal.fee:0);
        if(t==="target")return computeMoneyTotal(cell.target,{...targetVis,discount:false,overpaid:false});
        if(t==="paid")return computeMoneyTotal(cell.paid,paidVis)+(showBadDebtSale?cell.paid.badDebt:0);
        if(t==="due")return computeDueTotal(cell.due,dueVis);
        if(t==="notYetDue")return computeNotYetDueTotal(cell.notYetDue,notYetDueVis);
        return 0;
      };
      // กรอง bucket ที่ไม่ถูกซ่อน
      const visBuckets=DEBT_BUCKETS.filter(b=>!hiddenBuckets.has(b));
      // COL_GROUPS กรองเฉพาะ bucket ที่มองเห็น
      const visGroups=COL_GROUPS.map(g=>({...g,buckets:g.buckets.filter(b=>!hiddenBuckets.has(b))})).filter(g=>g.buckets.length>0);

      if(tab==="combined"&&combinedViewMode==="dueMonth"){
        // ── DueMonth sheet ────────────────────────────────────────────────────────────────────────────────
        // โครงสร้าง: เดือนอนุมัติ | หัวข้อ | รวม | due_month1 | due_month2 | ...
        type DueSubKey="count"|"installTotal"|"target"|"paid"|"due"|"notYetDue";
        const dueSubRows:[string,DueSubKey][]=[["สัญญา","count"],["ยอดผ่อนรวม","installTotal"],["เป้าเก็บหนี้","target"],["ยอดเก็บหนี้","paid"],["หนี้ค้างชำระ","due"],["ยังไม่ถึงกำหนด","notYetDue"]];
        const visDueSubRows=dueSubRows.filter(([,k])=>k==="count"||!hiddenSubRows.has(k as TabKey));
        const visibleDueRows=dueMonthRows.filter(r=>!hiddenRows.has(r.approveMonth));
        const dueHdr:(string|number|null)[]=["เดือน-ปีที่อนุมัติ","หัวข้อ","รวม",...allDueMonths.map(dm=>fmtMonthYear(dm))];
        const dueWsData:(string|number|null)[][]=[dueHdr];
        type DueCellType=DueMonthCellLocal;
        const getDueCellVal=(key:DueSubKey,cell:DueCellType|undefined):number=>{
          if(!cell)return 0;
          if(key==="count")return cell.contractCount;
          if(key==="installTotal")return (installVis.principal?cell.installTotal.principal:0)+(installVis.interest?cell.installTotal.interest:0)+(installVis.fee?cell.installTotal.fee:0);
          if(key==="target")return computeMoneyTotal(cell.target,{...targetVis,discount:false,overpaid:false});
          if(key==="paid")return computeMoneyTotal(cell.paid,paidVis);
          if(key==="due")return computeDueTotal(cell.due,dueVis);
          return computeNotYetDueTotal(cell.notYetDue,notYetDueVis);
        };
        type DueRowType=DueMonthRowLocal;
        const getDueRowTotal=(key:DueSubKey,row:DueRowType):number=>{
          if(key==="count")return row.approvedCount; // จำนวนสัญญาที่อนุมัติ
          if(key==="installTotal")return (installVis.principal?row.totalInstallTotal.principal:0)+(installVis.interest?row.totalInstallTotal.interest:0)+(installVis.fee?row.totalInstallTotal.fee:0);
          if(key==="target")return computeMoneyTotal(row.totalTarget,{...targetVis,discount:false,overpaid:false});
          if(key==="paid")return computeMoneyTotal(row.totalPaid,paidVis);
          if(key==="due")return computeDueTotal(row.totalDue,dueVis);
          return computeNotYetDueTotal(row.totalNotYetDue,notYetDueVis);
        };
        for(const row of visibleDueRows){
          for(const[subLabel,subKey] of visDueSubRows){
            const vals:(string|number|null)[]=[fmtMonthYear(row.approveMonth),subLabel,getDueRowTotal(subKey,row)||null];
            for(const dm of allDueMonths){const v=getDueCellVal(subKey,row.dueMonths[dm]);vals.push(v===0?null:v);}
            dueWsData.push(vals);
          }
        }
        // grand total rows
        const dueGtByDm:Record<string,Record<DueSubKey,number>>={};for(const dm of allDueMonths){dueGtByDm[dm]={count:0,installTotal:0,target:0,paid:0,due:0,notYetDue:0};}
        const dueGtTotal:Record<DueSubKey,number>={count:0,installTotal:0,target:0,paid:0,due:0,notYetDue:0};
        for(const row of visibleDueRows){
          for(const[,k] of visDueSubRows)dueGtTotal[k]+=getDueRowTotal(k,row);
          for(const dm of allDueMonths){const cell=row.dueMonths[dm];for(const[,k] of visDueSubRows)dueGtByDm[dm][k]+=getDueCellVal(k,cell);}
        }
        for(const[subLabel,subKey] of visDueSubRows){
          const gtVals:(string|number|null)[]=["รวมทั้งหมด",subLabel,dueGtTotal[subKey]||null];
          for(const dm of allDueMonths){const v=dueGtByDm[dm][subKey];gtVals.push(v===0?null:v);}
          dueWsData.push(gtVals);
        }
        const dueWs=XLSX.utils.aoa_to_sheet(dueWsData);
        XLSX.utils.book_append_sheet(wb,dueWs,"เดือนที่ต้องชำระ");
      } else if(tab==="combined"){
        // ── Combined sheet ────────────────────────────────────────────────────────────────────────────────
        // โครงสร้าง: เดือน | หัวข้อ | bucket1 | bucket2 | ... | รวม | % columns
        const subRows:[string,TabKey][]=[["สัญญา","count"],["ยอดผ่อนรวม","installTotal"],["เป้าเก็บหนี้","target"],["ยอดเก็บหนี้","paid"],["หนี้ค้างชำระ","due"],["ยังไม่ถึงกำหนด","notYetDue"]];
        // header row 1: group labels
        const hdr1:string[][]=[["เดือน-ปีที่อนุมัติ"],["หัวข้อ"]];
        for(const g of visGroups){
          hdr1.push([g.label]);
          for(let i=1;i<g.buckets.length;i++)hdr1.push([""]);
          if(g.hasSubtotal)hdr1.push([""]);
        }
        hdr1.push(["รวม"]);
        // header row 2: bucket names + subtotal + รวม + % columns แยก
        const hdr2:string[][]=[["เดือน-ปีที่อนุมัติ"],["หัวข้อ"]];
        for(const g of visGroups){
          for(const b of g.buckets)hdr2.push([b]);
          if(g.hasSubtotal)hdr2.push([g.label+" รวม"]);
        }
        hdr2.push(["รวม"],["รวม % ของยอดผ่อนรวม"],["รวม % ของเป้าเก็บหนี้"]);
        // hdr1 ต้องมีคอลัมน์เท่ากับ hdr2
        while(hdr1.length<hdr2.length)hdr1.push([""]);
        const wsData:(string|number|null)[][]=[hdr1.map(x=>x[0]),hdr2.map(x=>x[0])];
        // helper: คำนวณ subtotal ของ group
        const groupSubtotal=(row:SummaryRow,g:typeof visGroups[0],t:TabKey)=>g.buckets.reduce((s,b)=>s+getCellVal(b,row.buckets[b],t),0);
        const rowTotal=(row:SummaryRow,t:TabKey)=>visBuckets.reduce((s,b)=>s+getCellVal(b,row.buckets[b],t),0);
        for(const row of combinedRows){
          const installTotal=rowTotal(row,"installTotal");
          const targetTotal=rowTotal(row,"target");
          for(const[subLabel,subKey] of subRows){
            const vals:(string|number|null)[]=[fmtMonthYear(row.approveMonth),subLabel];
            for(const g of visGroups){
              for(const b of g.buckets)vals.push(getCellVal(b,row.buckets[b],subKey));
              if(g.hasSubtotal)vals.push(groupSubtotal(row,g,subKey));
            }
            const total=rowTotal(row,subKey);
            vals.push(total);
            // % columns
            if(subKey==="target"){
              vals.push(installTotal>0?Math.round((total/installTotal)*1000)/10:null);
              vals.push(null);
            } else if(subKey==="paid"){
              const paidNoSale=total-(showBadDebtSale?visBuckets.reduce((s,b)=>{const c=row.buckets[b];return s+(hiddenBuckets.has(b)?0:(c?.paid.badDebt??0));},0):0);
              vals.push(installTotal>0?Math.round((paidNoSale/installTotal)*1000)/10:null);
              vals.push(targetTotal>0?Math.round((paidNoSale/targetTotal)*1000)/10:null);
            } else if(subKey==="due"){
              vals.push(null);
              vals.push(targetTotal>0?Math.round((total/targetTotal)*1000)/10:null);
            } else if(subKey==="notYetDue"){
              vals.push(installTotal>0?Math.round((total/installTotal)*1000)/10:null);
              vals.push(null);
            } else {
              vals.push(null);vals.push(null);
            }
            wsData.push(vals);
          }
        }
        // grand total row
        const gtRow=(subLabel:string,subKey:TabKey)=>{
          const vals:(string|number|null)[]=["รวมทั้งหมด",subLabel];
          for(const g of visGroups){
            for(const b of g.buckets){const bt=grandTotal.bucketTotals[b];vals.push(bt?getCellVal(b,{contractCount:bt.count,paid:bt.paid,due:bt.due,target:bt.target,notYetDue:bt.notYetDue,installTotal:bt.installTotal},subKey):0);}
            if(g.hasSubtotal)vals.push(g.buckets.reduce((s,b)=>{const bt=grandTotal.bucketTotals[b];return s+(bt?getCellVal(b,{contractCount:bt.count,paid:bt.paid,due:bt.due,target:bt.target,notYetDue:bt.notYetDue,installTotal:bt.installTotal},subKey):0);},0));
          }
          const total=visBuckets.reduce((s,b)=>{const bt=grandTotal.bucketTotals[b];return s+(bt?getCellVal(b,{contractCount:bt.count,paid:bt.paid,due:bt.due,target:bt.target,notYetDue:bt.notYetDue,installTotal:bt.installTotal},subKey):0);},0);
          vals.push(total);
          vals.push(null);vals.push(null);
          return vals;
        };
        for(const[subLabel,subKey] of subRows)wsData.push(gtRow(subLabel,subKey));
        const ws=XLSX.utils.aoa_to_sheet(wsData);
        XLSX.utils.book_append_sheet(wb,ws,"สรุปรวม");
      } else {
        // ── แถบอื่น (count/installTotal/target/paid/due/notYetDue) ─────────────
        const tabLabel=tab==="count"?"สัญญา":tab==="installTotal"?"ยอดผ่อนรวม":tab==="target"?"เป้าเก็บหนี้":tab==="paid"?"ยอดเก็บหนี้":tab==="due"?"หนี้ค้างชำระ":"ยังไม่ถึงกำหนด";
        // header row 1: group labels
        const hdr1:string[]=["เดือน-ปีที่อนุมัติ"];
        for(const g of visGroups){
          hdr1.push(g.label);
          for(let i=1;i<g.buckets.length;i++)hdr1.push("");
          if(g.hasSubtotal)hdr1.push("");
        }
        hdr1.push("รวม");
        if(tab==="target")hdr1.push("% ของยอดผ่อนรวม");
        if(tab==="paid"){hdr1.push("% ของยอดผ่อนรวม");hdr1.push("% ของเป้าเก็บหนี้");}
        if(tab==="due")hdr1.push("% ของเป้าเก็บหนี้");
        if(tab==="notYetDue")hdr1.push("% ของยอดผ่อนรวม");
        // header row 2: bucket names + subtotal
        const hdr2:string[]=["เดือน-ปีที่อนุมัติ"];
        for(const g of visGroups){
          for(const b of g.buckets)hdr2.push(b);
          if(g.hasSubtotal)hdr2.push(`${g.label} รวม`);
        }
        hdr2.push("รวม");
        if(tab==="target")hdr2.push("% ของยอดผ่อนรวม");
        if(tab==="paid"){hdr2.push("% ของยอดผ่อนรวม");hdr2.push("% ของเป้าเก็บหนี้");}
        if(tab==="due")hdr2.push("% ของเป้าเก็บหนี้");
        if(tab==="notYetDue")hdr2.push("% ของยอดผ่อนรวม");
        const wsData:(string|number|null)[][]=[hdr1,hdr2];
        // helper: installTotal per row (สำหรับคำนวณ %)
        const rowInstall=(row:SummaryRow)=>visBuckets.reduce((s,b)=>s+getCellVal(b,row.buckets[b],"installTotal"),0);
        const rowTarget=(row:SummaryRow)=>visBuckets.reduce((s,b)=>s+getCellVal(b,row.buckets[b],"target"),0);
        for(const row of rows){
          const vals:(string|number|null)[]=[fmtMonthYear(row.approveMonth)];
          for(const g of visGroups){
            for(const b of g.buckets)vals.push(getCellVal(b,row.buckets[b],tab));
            if(g.hasSubtotal)vals.push(g.buckets.reduce((s,b)=>s+getCellVal(b,row.buckets[b],tab),0));
          }
          const total=visBuckets.reduce((s,b)=>s+getCellVal(b,row.buckets[b],tab),0);
          vals.push(total);
          if(tab==="target"){const inst=rowInstall(row);vals.push(inst>0?Math.round((total/inst)*1000)/10:null);}
          else if(tab==="paid"){
            const inst=rowInstall(row);const tgt=rowTarget(row);
            const paidNoSale=total-(showBadDebtSale?visBuckets.reduce((s,b)=>{const c=row.buckets[b];return s+(hiddenBuckets.has(b)?0:(c?.paid.badDebt??0));},0):0);
            vals.push(inst>0?Math.round((paidNoSale/inst)*1000)/10:null);
            vals.push(tgt>0?Math.round((paidNoSale/tgt)*1000)/10:null);
          }
          else if(tab==="due"){const tgt=rowTarget(row);vals.push(tgt>0?Math.round((total/tgt)*1000)/10:null);}
          else if(tab==="notYetDue"){const inst=rowInstall(row);vals.push(inst>0?Math.round((total/inst)*1000)/10:null);}
          wsData.push(vals);
        }
        // grand total row
        const gtVals:(string|number|null)[]=["รวมทั้งหมด"];
        for(const g of visGroups){
          for(const b of g.buckets){const bt=grandTotal.bucketTotals[b];gtVals.push(bt?getCellVal(b,{contractCount:bt.count,paid:bt.paid,due:bt.due,target:bt.target,notYetDue:bt.notYetDue,installTotal:bt.installTotal},tab):0);}
          if(g.hasSubtotal)gtVals.push(g.buckets.reduce((s,b)=>{const bt=grandTotal.bucketTotals[b];return s+(bt?getCellVal(b,{contractCount:bt.count,paid:bt.paid,due:bt.due,target:bt.target,notYetDue:bt.notYetDue,installTotal:bt.installTotal},tab):0);},0));
        }
        const gtTotal=visBuckets.reduce((s,b)=>{const bt=grandTotal.bucketTotals[b];return s+(bt?getCellVal(b,{contractCount:bt.count,paid:bt.paid,due:bt.due,target:bt.target,notYetDue:bt.notYetDue,installTotal:bt.installTotal},tab):0);},0);
        gtVals.push(gtTotal);
        if(tab==="target"||tab==="paid"||tab==="due"||tab==="notYetDue"){gtVals.push(null);if(tab==="paid")gtVals.push(null);}
        wsData.push(gtVals);
        const ws=XLSX.utils.aoa_to_sheet(wsData);
        XLSX.utils.book_append_sheet(wb,ws,tabLabel);
      }
      XLSX.writeFile(wb,`monthly_summary_${tab}_${new Date().toISOString().slice(0,10)}.xlsx`);
      toast.success("Export สำเร็จ");
    }catch{toast.error("Export ล้มเหลว");}
  },[canExport,rows,combinedRows,tab,hiddenBuckets,paidVis,targetVis,dueVis,notYetDueVis,installVis,showBadDebtSale,grandTotal,combinedViewMode,dueMonthRows,allDueMonths,hiddenSubRows,hiddenRows]);

  const handleExportRef=useRef(handleExport);
  handleExportRef.current=handleExport;

  useEffect(()=>{
    setActions(
      <div className="flex items-center gap-2">
        {/* ปุ่ม Repopulate Monthly Summary — แสดงเฉพาะ superAdmin */}
        {isSuperAdmin&&(
          <button
            type="button"
            onClick={handleRepopulateMonthlySummary}
            disabled={isRepopulating}
            title="ประมวลผล Monthly Summary Cache ใหม่ (superAdmin only)"
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-purple-200 hover:bg-purple-50 text-sm text-purple-700 disabled:opacity-50 transition-colors"
          >
            <TrendingUp className={`w-4 h-4 ${isRepopulating?"animate-pulse":""}`}/>
            <span className="hidden sm:inline">{isRepopulating?"กำลังประมวลผล...":"Repopulate Summary"}</span>
          </button>
        )}
        <SyncStatusBar/>
      </div>
    );
    return()=>setActions(null);
  },[setActions,isSuperAdmin,isRepopulating,handleRepopulateMonthlySummary]);

  // ── Tab config ────────────────────────────────────────────────────────────────────
  const TAB_CONFIG: Array<{key:TabKey;label:string;activeClass:string;filterCount:number}> = [
    {key:"count",        label:"สัญญา",       activeClass:"border-slate-600 text-slate-700",   filterCount:countFilterCount},
    {key:"installTotal", label:"ยอดผ่อนรวม",       activeClass:"border-purple-600 text-purple-700", filterCount:[installApproveMonths.size>0,installApproveYears.size>0,installProductType.size>0,installDeviceFamily].filter(Boolean).length},
    {key:"target",       label:"เป้าเก็บหนี้",       activeClass:"border-indigo-600 text-indigo-700", filterCount:targetFilterCount},
    {key:"paid",         label:"ยอดเก็บหนี้",     activeClass:"border-green-600 text-green-700",   filterCount:paidFilterCount},
    {key:"due",          label:"หนี้ค้างชำระ",   activeClass:"border-orange-600 text-orange-700", filterCount:dueFilterCount},
    {key:"notYetDue",    label:"ยังไม่ถึงกำหนด", activeClass:"border-blue-600 text-blue-700",     filterCount:notYetDueFilterCount},
    {key:"combined",     label:"สรุปรวม",          activeClass:"border-teal-600 text-teal-700",     filterCount:[combinedApproveMonths.size>0,combinedApproveYears.size>0,combinedProductType.size>0,combinedDeviceFamily].filter(Boolean).length},
  ];

  return(
    <AppShell fullHeight>
      <div className="flex flex-col h-full">
      {/* ── Header area ──────────────────────────────────────────────── */}
      <div className="flex-shrink-0 bg-white" ref={headerRef}>
        {/* ── Tab switcher + Export ─────────────────────────────────── */}
        <div className="bg-white border-b border-gray-200 px-4 flex items-center gap-0 overflow-x-auto">
          <span className="text-sm font-semibold text-gray-700 whitespace-nowrap flex-shrink-0">สรุปรายเดือน</span>
          <span className="mr-2"/>
          {TAB_CONFIG.map((t)=>(
            <button key={t.key} type="button" onClick={()=>setTab(t.key)}
              className={["relative px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap flex-shrink-0",tab===t.key?t.activeClass:"border-transparent text-gray-400 hover:text-gray-600"].join(" ")}>
              {t.label}{t.filterCount>0&&<span className="ml-1 inline-flex items-center justify-center bg-blue-500 text-white rounded-full w-4 h-4 text-[10px] font-bold">{t.filterCount}</span>}
            </button>
          ))}
          {/* ปุ่ม i อธิบายความหมายแต่ละแถบ — วางหลัง tab สุดท้าย */}
          <span className="flex items-center px-2 flex-shrink-0">
            <TabInfoPopup/>
          </span>

        </div>

        {/* ── Filter bar ───────────────────────────────────────────── */}
        <div className="bg-white border-b border-gray-200 shadow-sm">
            <div className="px-4 pb-3 pt-2 flex flex-wrap items-center gap-2">
              {/* Search box — แสดงทุก tab ยกเว้น combined */}
              {tab!=="combined"&&(
                <div className="relative flex items-center">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none"/>
                  <input
                    type="text"
                    value={searchInput}
                    onChange={(e)=>setSearchInput(e.target.value)}
                    placeholder="ค้นหา: สัญญา / ลูกค้า"
                    className="h-9 pl-8 pr-7 rounded-md border border-gray-200 bg-white text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 w-[200px]"
                  />
                  {searchInput&&(
                    <button type="button" onClick={()=>{setSearchInput("");setSearch("");}} className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center justify-center w-5 h-5 rounded-full bg-gray-100 hover:bg-red-100 text-gray-400 hover:text-red-500">
                      <X className="w-3 h-3"/>
                    </button>
                  )}
                </div>
              )}
              {/* Tab 1: จำนวนสัญญา */}
              {tab==="count"&&(
                <>
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-gray-500 whitespace-nowrap">วันที่อนุมัติ:</span>
                    <div className="relative flex items-center">
                      <CalendarDays className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none"/>
                      <input type="date" value={countApproveDate}
                        onChange={(e)=>{setCountApproveDate(e.target.value);if(e.target.value)setCountApproveMonths(new Set());}}
                        className="h-9 pl-8 pr-2 rounded-md border border-gray-200 bg-white text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 w-[155px]"/>
                      {countApproveDate&&<button type="button" onClick={()=>setCountApproveDate("")} className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center justify-center w-5 h-5 rounded-full bg-gray-100 hover:bg-red-100 text-gray-400 hover:text-red-500"><X className="w-3 h-3"/></button>}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-gray-500 whitespace-nowrap">เดือน-ปี:</span>
                    <MonthMultiSelect selected={countApproveMonths} onChange={(v)=>{setCountApproveMonths(v);if(v.size>0)setCountApproveDate("");}} options={availableMonths}/>
                    {countApproveMonths.size>0&&<button type="button" onClick={()=>setCountApproveMonths(new Set())} className="flex items-center justify-center w-6 h-6 rounded-full bg-gray-100 hover:bg-red-100 text-gray-400 hover:text-red-500"><X className="w-3.5 h-3.5"/></button>}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-gray-500 whitespace-nowrap">ปีที่อนุมัติ:</span>
                    <YearMultiSelect selected={countApproveYears} onChange={setCountApproveYears} options={availableYears}/>
                    {countApproveYears.size>0&&<button type="button" onClick={()=>setCountApproveYears(new Set())} className="flex items-center justify-center w-6 h-6 rounded-full bg-gray-100 hover:bg-red-100 text-gray-400 hover:text-red-500"><X className="w-3.5 h-3.5"/></button>}
                  </div>
                  <DeviceFamilyFilter value={countDeviceFamily} onChange={setCountDeviceFamily}/>
                  <MultiSelectFilter label="ประเภทสินค้า" selected={countProductType} onChange={setCountProductType} options={productTypes} placeholder="ทุกประเภทสินค้า"/>
                  {countFilterCount>0&&(
                    <button type="button" onClick={()=>{setSearchInput("");setSearch("");setCountApproveDate("");setCountApproveMonths(new Set());setCountApproveYears(new Set());setCountProductType(new Set());setCountDeviceFamily("");}}
                      className="flex items-center gap-1 h-9 px-2.5 rounded-md border border-red-200 bg-red-50 text-red-600 text-xs hover:bg-red-100 transition-colors">
                      <X className="w-3.5 h-3.5"/>ล้างทั้งหมด
                    </button>
                  )}
                </>
              )}
              {/* Tab installTotal: ยอดผ่อนรวม */}
              {tab==="installTotal"&&(
                <>
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-gray-500 whitespace-nowrap">เดือน-ปีที่อนุมัติ:</span>
                    <MonthMultiSelect selected={installApproveMonths} onChange={setInstallApproveMonths} options={availableMonths}/>
                    {installApproveMonths.size>0&&<button type="button" onClick={()=>setInstallApproveMonths(new Set())} className="flex items-center justify-center w-6 h-6 rounded-full bg-gray-100 hover:bg-red-100 text-gray-400 hover:text-red-500"><X className="w-3.5 h-3.5"/></button>}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-gray-500 whitespace-nowrap">ปีที่อนุมัติ:</span>
                    <YearMultiSelect selected={installApproveYears} onChange={setInstallApproveYears} options={availableYears}/>
                    {installApproveYears.size>0&&<button type="button" onClick={()=>setInstallApproveYears(new Set())} className="flex items-center justify-center w-6 h-6 rounded-full bg-gray-100 hover:bg-red-100 text-gray-400 hover:text-red-500"><X className="w-3.5 h-3.5"/></button>}
                  </div>
                  <DeviceFamilyFilter value={installDeviceFamily} onChange={setInstallDeviceFamily}/>
                  <MultiSelectFilter label="ประเภทสินค้า" selected={installProductType} onChange={setInstallProductType} options={productTypes} placeholder="ทุกประเภทสินค้า"/>
                  {installFilterCount>0&&(
                    <button type="button" onClick={()=>{setSearchInput("");setSearch("");setInstallApproveMonths(new Set());setInstallApproveYears(new Set());setInstallProductType(new Set());setInstallDeviceFamily("");}}
                      className="flex items-center gap-1 h-9 px-2.5 rounded-md border border-red-200 bg-red-50 text-red-600 text-xs hover:bg-red-100 transition-colors">
                      <X className="w-3.5 h-3.5"/>ล้างทั้งหมด
                    </button>
                  )}
                </>
              )}
              {/* Tab 2: ยอดที่ต้องชำระ */}
              {tab==="target"&&(
                <>
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-gray-500 whitespace-nowrap">วันที่ต้องชำระ:</span>
                    <div className="relative flex items-center">
                      <CalendarDays className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none"/>
                      <input type="date" value={targetDueDate}
                        onChange={(e)=>{setTargetDueDate(e.target.value);if(e.target.value)setTargetDueMonths(new Set());}}
                        className="h-9 pl-8 pr-2 rounded-md border border-gray-200 bg-white text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 w-[155px]"/>
                      {targetDueDate&&<button type="button" onClick={()=>setTargetDueDate("")} className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center justify-center w-5 h-5 rounded-full bg-gray-100 hover:bg-red-100 text-gray-400 hover:text-red-500"><X className="w-3 h-3"/></button>}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-gray-500 whitespace-nowrap">เดือน-ปีที่ต้องชำระ:</span>
                    <MonthMultiSelect selected={targetDueMonths} onChange={(v)=>{setTargetDueMonths(v);if(v.size>0)setTargetDueDate("");}} options={availableMonths}/>
                    {targetDueMonths.size>0&&<button type="button" onClick={()=>setTargetDueMonths(new Set())} className="flex items-center justify-center w-6 h-6 rounded-full bg-gray-100 hover:bg-red-100 text-gray-400 hover:text-red-500"><X className="w-3.5 h-3.5"/></button>}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-gray-500 whitespace-nowrap">เดือน-ปีที่อนุมัติ:</span>
                    <MonthMultiSelect selected={targetApproveMonths} onChange={setTargetApproveMonths} options={availableMonths}/>
                    {targetApproveMonths.size>0&&<button type="button" onClick={()=>setTargetApproveMonths(new Set())} className="flex items-center justify-center w-6 h-6 rounded-full bg-gray-100 hover:bg-red-100 text-gray-400 hover:text-red-500"><X className="w-3.5 h-3.5"/></button>}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-gray-500 whitespace-nowrap">ปีที่อนุมัติ:</span>
                    <YearMultiSelect selected={targetApproveYears} onChange={setTargetApproveYears} options={availableYears}/>
                    {targetApproveYears.size>0&&<button type="button" onClick={()=>setTargetApproveYears(new Set())} className="flex items-center justify-center w-6 h-6 rounded-full bg-gray-100 hover:bg-red-100 text-gray-400 hover:text-red-500"><X className="w-3.5 h-3.5"/></button>}
                  </div>
                  <DeviceFamilyFilter value={targetDeviceFamily} onChange={setTargetDeviceFamily}/>
                  <MultiSelectFilter label="ประเภทสินค้า" selected={targetProductType} onChange={setTargetProductType} options={productTypes} placeholder="ทุกประเภทสินค้า"/>
                  {targetFilterCount>0&&(
                    <button type="button" onClick={()=>{setSearchInput("");setSearch("");setTargetDueDate("");setTargetDueMonths(new Set());setTargetApproveMonths(new Set());setTargetApproveYears(new Set());setTargetProductType(new Set());setTargetDeviceFamily("");}}
                      className="flex items-center gap-1 h-9 px-2.5 rounded-md border border-red-200 bg-red-50 text-red-600 text-xs hover:bg-red-100 transition-colors">
                      <X className="w-3.5 h-3.5"/>ล้างทั้งหมด
                    </button>
                  )}
                </>
              )}
              {/* Tab 3: ยอดชำระแล้ว */}
              {tab==="paid"&&(
                <>
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-gray-500 whitespace-nowrap">วันที่ชำระ:</span>
                    <div className="relative flex items-center">
                      <CalendarDays className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none"/>
                      <input type="date" value={paidAtDate}
                        onChange={(e)=>{setPaidAtDate(e.target.value);if(e.target.value)setPaidAtMonths(new Set());}}
                        className="h-9 pl-8 pr-2 rounded-md border border-gray-200 bg-white text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-green-500 w-[155px]"/>
                      {paidAtDate&&<button type="button" onClick={()=>setPaidAtDate("")} className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center justify-center w-5 h-5 rounded-full bg-gray-100 hover:bg-red-100 text-gray-400 hover:text-red-500"><X className="w-3 h-3"/></button>}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-gray-500 whitespace-nowrap">เดือน-ปี:</span>
                    <MonthMultiSelect selected={paidAtMonths} onChange={(v)=>{setPaidAtMonths(v);if(v.size>0)setPaidAtDate("");}} options={availableMonths}/>
                    {paidAtMonths.size>0&&<button type="button" onClick={()=>setPaidAtMonths(new Set())} className="flex items-center justify-center w-6 h-6 rounded-full bg-gray-100 hover:bg-red-100 text-gray-400 hover:text-red-500"><X className="w-3.5 h-3.5"/></button>}
                  </div>
                  <DeviceFamilyFilter value={paidDeviceFamily} onChange={setPaidDeviceFamily}/>
                  <MultiSelectFilter label="ประเภทสินค้า" selected={paidProductType} onChange={setPaidProductType} options={productTypes} placeholder="ทุกประเภทสินค้า"/>
                  {paidFilterCount>0&&(
                    <button type="button" onClick={()=>{setSearchInput("");setSearch("");setPaidAtDate("");setPaidAtMonths(new Set());setPaidProductType(new Set());setPaidDeviceFamily("");}}
                      className="flex items-center gap-1 h-9 px-2.5 rounded-md border border-red-200 bg-red-50 text-red-600 text-xs hover:bg-red-100 transition-colors">
                      <X className="w-3.5 h-3.5"/>ล้างทั้งหมด
                    </button>
                  )}
                </>
              )}
              {/* Tab 4: ยอดค้างชำระ */}
              {tab==="due"&&(
                <>
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-gray-500 whitespace-nowrap">วันที่ต้องชำระ:</span>
                    <div className="relative flex items-center">
                      <CalendarDays className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none"/>
                      <input type="date" value={dueAtDate}
                        onChange={(e)=>{setDueAtDate(e.target.value);if(e.target.value)setDueAtMonths(new Set());}}
                        className="h-9 pl-8 pr-2 rounded-md border border-gray-200 bg-white text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-orange-500 w-[155px]"/>
                      {dueAtDate&&<button type="button" onClick={()=>setDueAtDate("")} className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center justify-center w-5 h-5 rounded-full bg-gray-100 hover:bg-red-100 text-gray-400 hover:text-red-500"><X className="w-3 h-3"/></button>}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-gray-500 whitespace-nowrap">เดือน-ปี:</span>
                    <MonthMultiSelect selected={dueAtMonths} onChange={(v)=>{setDueAtMonths(v);if(v.size>0)setDueAtDate("");}} options={availableMonths}/>
                    {dueAtMonths.size>0&&<button type="button" onClick={()=>setDueAtMonths(new Set())} className="flex items-center justify-center w-6 h-6 rounded-full bg-gray-100 hover:bg-red-100 text-gray-400 hover:text-red-500"><X className="w-3.5 h-3.5"/></button>}
                  </div>
                  <DeviceFamilyFilter value={dueDeviceFamily} onChange={setDueDeviceFamily}/>
                  <MultiSelectFilter label="ประเภทสินค้า" selected={dueProductType} onChange={setDueProductType} options={productTypes} placeholder="ทุกประเภทสินค้า"/>
                  {dueFilterCount>0&&(
                    <button type="button" onClick={()=>{setSearchInput("");setSearch("");setDueAtDate("");setDueAtMonths(new Set());setDueProductType(new Set());setDueDeviceFamily("");}}
                      className="flex items-center gap-1 h-9 px-2.5 rounded-md border border-red-200 bg-red-50 text-red-600 text-xs hover:bg-red-100 transition-colors">
                      <X className="w-3.5 h-3.5"/>ล้างทั้งหมด
                    </button>
                  )}
                </>
              )}
              {/* Tab 5: ยอดที่ยังไม่ถึงกำหนด */}
              {tab==="notYetDue"&&(
                <>
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-gray-500 whitespace-nowrap">วันที่ต้องชำระ:</span>
                    <div className="relative flex items-center">
                      <CalendarDays className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none"/>
                      <input type="date" value={notYetDueDueDate}
                        onChange={(e)=>{setNotYetDueDueDate(e.target.value);if(e.target.value)setNotYetDueDueMonths(new Set());}}
                        className="h-9 pl-8 pr-2 rounded-md border border-gray-200 bg-white text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 w-[155px]"/>
                      {notYetDueDueDate&&<button type="button" onClick={()=>setNotYetDueDueDate("")} className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center justify-center w-5 h-5 rounded-full bg-gray-100 hover:bg-red-100 text-gray-400 hover:text-red-500"><X className="w-3 h-3"/></button>}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-gray-500 whitespace-nowrap">เดือน-ปีที่ต้องชำระ:</span>
                    <MonthMultiSelect selected={notYetDueDueMonths} onChange={(v)=>{setNotYetDueDueMonths(v);if(v.size>0)setNotYetDueDueDate("");}} options={availableMonths}/>
                    {notYetDueDueMonths.size>0&&<button type="button" onClick={()=>setNotYetDueDueMonths(new Set())} className="flex items-center justify-center w-6 h-6 rounded-full bg-gray-100 hover:bg-red-100 text-gray-400 hover:text-red-500"><X className="w-3.5 h-3.5"/></button>}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-gray-500 whitespace-nowrap">เดือน-ปีที่อนุมัติ:</span>
                    <MonthMultiSelect selected={notYetDueApproveMonths} onChange={setNotYetDueApproveMonths} options={availableMonths}/>
                    {notYetDueApproveMonths.size>0&&<button type="button" onClick={()=>setNotYetDueApproveMonths(new Set())} className="flex items-center justify-center w-6 h-6 rounded-full bg-gray-100 hover:bg-red-100 text-gray-400 hover:text-red-500"><X className="w-3.5 h-3.5"/></button>}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-gray-500 whitespace-nowrap">ปีที่อนุมัติ:</span>
                    <YearMultiSelect selected={notYetDueApproveYears} onChange={setNotYetDueApproveYears} options={availableYears}/>
                    {notYetDueApproveYears.size>0&&<button type="button" onClick={()=>setNotYetDueApproveYears(new Set())} className="flex items-center justify-center w-6 h-6 rounded-full bg-gray-100 hover:bg-red-100 text-gray-400 hover:text-red-500"><X className="w-3.5 h-3.5"/></button>}
                  </div>
                  <DeviceFamilyFilter value={notYetDueDeviceFamily} onChange={setNotYetDueDeviceFamily}/>
                  <MultiSelectFilter label="ประเภทสินค้า" selected={notYetDueProductType} onChange={setNotYetDueProductType} options={productTypes} placeholder="ทุกประเภทสินค้า"/>
                  {notYetDueFilterCount>0&&(
                    <button type="button" onClick={()=>{setSearchInput("");setSearch("");setNotYetDueDueDate("");setNotYetDueDueMonths(new Set());setNotYetDueApproveMonths(new Set());setNotYetDueApproveYears(new Set());setNotYetDueProductType(new Set());setNotYetDueDeviceFamily("");}}
                      className="flex items-center gap-1 h-9 px-2.5 rounded-md border border-red-200 bg-red-50 text-red-600 text-xs hover:bg-red-100 transition-colors">
                      <X className="w-3.5 h-3.5"/>ล้างทั้งหมด
                    </button>
                  )}
                </>
              )}
              {/* Tab 6: สรุปรวม */}
              {tab==="combined"&&(
                <>
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-gray-500 whitespace-nowrap">เดือน-ปีที่อนุมัติ:</span>
                    <MonthMultiSelect selected={combinedApproveMonths} onChange={setCombinedApproveMonths} options={availableMonths}/>
                    {combinedApproveMonths.size>0&&<button type="button" onClick={()=>setCombinedApproveMonths(new Set())} className="flex items-center justify-center w-6 h-6 rounded-full bg-gray-100 hover:bg-red-100 text-gray-400 hover:text-red-500"><X className="w-3.5 h-3.5"/></button>}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-gray-500 whitespace-nowrap">ปีที่อนุมัติ:</span>
                    <YearMultiSelect selected={combinedApproveYears} onChange={setCombinedApproveYears} options={availableYears}/>
                    {combinedApproveYears.size>0&&<button type="button" onClick={()=>setCombinedApproveYears(new Set())} className="flex items-center justify-center w-6 h-6 rounded-full bg-gray-100 hover:bg-red-100 text-gray-400 hover:text-red-500"><X className="w-3.5 h-3.5"/></button>}
                  </div>
                  <DeviceFamilyFilter value={combinedDeviceFamily} onChange={setCombinedDeviceFamily}/>
                  <MultiSelectFilter label="ประเภทสินค้า" selected={combinedProductType} onChange={setCombinedProductType} options={productTypes} placeholder="ทุกประเภทสินค้า"/>
                  {/* Row Toggle — เปิด/ปิดแต่ละแถบ */}
                  {([
                    {key:"installTotal" as TabKey,label:"ยอดผ่อนรวม",color:"purple"},
                    {key:"target"       as TabKey,label:"เป้าเก็บหนี้",color:"indigo"},
                    {key:"paid"         as TabKey,label:"ยอดเก็บหนี้",color:"green"},
                    {key:"due"          as TabKey,label:"หนี้ค้างชำระ",color:"orange"},
                    {key:"notYetDue"    as TabKey,label:"ยังไม่ถึงกำหนด",color:"blue"},
                  ] as Array<{key:TabKey;label:string;color:string}>).map(({key,label,color})=>{
                    const isHidden=hiddenSubRows.has(key);
                    return(
                      <button key={key} type="button" onClick={()=>toggleSubRow(key)}
                        className={["flex items-center gap-1 h-7 px-2.5 rounded-full border text-xs font-medium transition-colors",
                          isHidden
                            ?"bg-gray-100 border-gray-200 text-gray-400 line-through"
                            :`bg-${color}-50 border-${color}-300 text-${color}-700 hover:bg-${color}-100`
                        ].join(" ")}>
                        {isHidden?<EyeOff className="w-3 h-3"/>:<Eye className="w-3 h-3"/>}
                        {label}
                      </button>
                    );
                  })}
                  {/* Pill Tab: สถานะหนี้ / เดือนที่ต้องชำระ */}
                  <div className="flex items-center gap-0.5 ml-1 bg-gray-100 rounded-full p-0.5">
                    <button type="button" onClick={()=>setCombinedViewMode("bucket")}
                      className={["h-7 px-3 rounded-full text-xs font-medium transition-colors",combinedViewMode==="bucket"?"bg-white text-teal-700 shadow-sm font-semibold":"text-gray-500 hover:text-gray-700"].join(" ")}>
                      สถานะหนี้
                    </button>
                    <button type="button" onClick={()=>setCombinedViewMode("dueMonth")}
                      className={["h-7 px-3 rounded-full text-xs font-medium transition-colors",combinedViewMode==="dueMonth"?"bg-white text-teal-700 shadow-sm font-semibold":"text-gray-500 hover:text-gray-700"].join(" ")}>
                      เดือนที่ต้องชำระ
                    </button>
                  </div>
                  {[combinedApproveMonths.size>0,combinedApproveYears.size>0,combinedProductType.size>0,combinedDeviceFamily].filter(Boolean).length>0&&(
                    <button type="button" onClick={()=>{setSearchInput("");setSearch("");setCombinedApproveMonths(new Set());setCombinedApproveYears(new Set());setCombinedProductType(new Set());setCombinedDeviceFamily("");}}
                      className="flex items-center gap-1 h-9 px-2.5 rounded-md border border-red-200 bg-red-50 text-red-600 text-xs hover:bg-red-100 transition-colors">
                      <X className="w-3.5 h-3.5"/>ล้างทั้งหมด
                    </button>
                  )}
                </>
              )}
              {/* Export Excel — แสดงท้าย filter bar ทุก tab */}
              {canExport&&(
                <button type="button" onClick={handleExport}
                  className="ml-auto flex items-center gap-1.5 h-9 px-3 text-sm font-medium rounded-md bg-green-600 hover:bg-green-700 text-white transition-colors whitespace-nowrap">
                  <Download className="w-4 h-4"/><span className="hidden sm:inline">Export Excel</span>
                </button>
              )}
            </div>
        </div>
        {/* ── Badge: installTotalall ─────────────────────────────────────────────── */}
        {tab==="installTotal"&&(
          <div className="bg-purple-50/60 border-b border-purple-200 px-4 py-2 flex flex-wrap items-center gap-2">
            {([{key:"principal",label:"เงินต้น",icon:<Banknote className="w-3 h-3"/>},{key:"interest",label:"ดอกเบี้ย",icon:<Percent className="w-3 h-3"/>},{key:"fee",label:"ค่าดำเนินการ",icon:<Coins className="w-3 h-3"/>}] as Array<{key:"principal"|"interest"|"fee";label:string;icon:React.ReactNode}>).map(({key,label,icon})=>{
              const isOn=installVis[key];const val=grandBadgeInstallTotal[key];
              return(
                <button key={key} type="button" onClick={()=>setInstallVis(p=>({...p,[key]:!p[key]}))}
                  className={["flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border transition-colors",isOn?"bg-purple-100 border-purple-300 text-purple-800":"bg-gray-100 border-gray-200 text-gray-400"].join(" ")}>
                  {icon}<span>{label}</span>
                  <span className={["font-semibold ml-0.5",isOn?"":"text-gray-400"].join(" ")}>{fmtMoney(val)}</span>
                  {isOn?<Eye className="w-3 h-3 ml-0.5 opacity-60"/>:<EyeOff className="w-3 h-3 ml-0.5 opacity-50"/>}
                </button>
              );
            })}
            {/* ยอดหนี้รวม */}
            <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border bg-purple-700 border-purple-800 text-white font-semibold">
              <Banknote className="w-3.5 h-3.5"/><span>ยอดผ่อนรวม</span>
              <span>{fmtMoney((installVis.principal?grandBadgeInstallTotal.principal:0)+(installVis.interest?grandBadgeInstallTotal.interest:0)+(installVis.fee?grandBadgeInstallTotal.fee:0))}</span>
            </div>
          </div>
        )}

        {/* ── Badge: target ───────────────────────────────────────────────────── */}
        {/* เป้าเก็บหนี้ = SUM(principal+interest+fee) ทุกงวดถึงกำหนด + penalty + unlock_fee งวดล่าสุด */}
        {tab=="target"&&(
          <div className="bg-indigo-50/60 border-b border-indigo-200 px-4 py-2 flex flex-wrap items-center gap-2">
            {([{key:"principal",label:"เงินต้น",icon:<Banknote className="w-3 h-3"/>},{key:"interest",label:"ดอกเบี้ย",icon:<Percent className="w-3 h-3"/>},{key:"fee",label:"ค่าดำเนินการ",icon:<Coins className="w-3 h-3"/>},{key:"penalty",label:"ค่าปรับ",icon:<Gavel className="w-3 h-3"/>},{key:"unlockFee",label:"ค่าปลดล็อก",icon:<Tag className="w-3 h-3"/>}] as Array<{key:MoneyBadgeKey;label:string;icon:React.ReactNode}>).map(({key,label,icon})=>{
              const isOn=targetVis[key];const val=grandBadgeTarget[key as keyof MoneyBreakdown] as number;
              return(
                <button key={key} type="button" onClick={()=>setTargetVis(p=>({...p,[key]:!p[key]}))}
                  className={["flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border transition-colors",isOn?"bg-indigo-100 border-indigo-300 text-indigo-800":"bg-gray-100 border-gray-200 text-gray-400"].join(" ")}>
                  {icon}<span>{label}</span>
                  <span className={["font-semibold ml-0.5",isOn?"":"text-gray-400"].join(" ")}>{fmtMoney(val)}</span>
                  {isOn?<Eye className="w-3 h-3 ml-0.5 opacity-60"/>:<EyeOff className="w-3 h-3 ml-0.5 opacity-50"/>}
                </button>
              );
             })}
            {/* รวมเป้าเก็บหนี้ */}
            <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border bg-indigo-700 border-indigo-800 text-white font-semibold">
              <Banknote className="w-3.5 h-3.5"/>
              <span>รวมเป้าเก็บหนี้</span>
              <span>{fmtMoney(computeMoneyTotal(grandBadgeTarget,{...targetVis,discount:false,overpaid:false}))}</span>
            </div>
          </div>
        )}

        {/* ── Badge: paid ───────────────────────────────────────────── */}
         {tab=="paid"&&(
          <div className="bg-green-50/60 border-b border-green-200 px-4 py-2 flex flex-wrap items-center gap-2">
            {MONEY_BADGE_ITEMS.map(({key,label,icon,canToggle})=>{const isOn=paidVis[key];const val=grandBadgePaid[key as keyof MoneyBreakdown];return(
              <button key={key} type="button" onClick={()=>{if(!canToggle)return;setPaidVis((p)=>({...p,[key]:!p[key]}));}}
                title={canToggle?(isOn?`ซ่อน${label}`:`แสดง${label}`):`${label} (ปิดเสมอ)`}
                className={["flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border transition-colors",!canToggle?"cursor-not-allowed bg-gray-100 border-gray-200 text-gray-400":isOn?"bg-green-100 border-green-300 text-green-800 hover:bg-green-200":"bg-gray-100 border-gray-200 text-gray-400 hover:bg-gray-200"].join(" ")}>
                {icon}<span>{label}</span>
                <span className={["font-semibold ml-0.5",!canToggle?"text-gray-400":isOn?"":"text-gray-400"].join(" ")}>{fmtMoney(val)}</span>
                {canToggle&&(isOn?<Eye className="w-3 h-3 ml-0.5 opacity-60"/>:<EyeOff className="w-3 h-3 ml-0.5 opacity-50"/>)}
              </button>
            );})}            {/* Badge ขายเครื่อง(หนี้เสีย) ยังคงแยกออกมา */}
            {(()=>{const saleAmt=grandTotal.totalPaid.badDebt??0;return(
              <button type="button" onClick={()=>setShowBadDebtSale(v=>!v)}
                title={showBadDebtSale?"ซ่อนยอดขายเครื่อง":"แสดงยอดขายเครื่อง"}
                className={["flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border transition-colors",showBadDebtSale?"bg-red-100 border-red-300 text-red-800 hover:bg-red-200":"bg-gray-100 border-gray-200 text-gray-400 hover:bg-gray-200"].join(" ")}>
                <Smartphone className="w-3 h-3"/><span>ขายเครื่อง</span>
                <span className={["font-semibold ml-0.5",showBadDebtSale?"":"text-gray-400"].join(" ")}>{fmtMoney(saleAmt)}</span>
                {showBadDebtSale?<Eye className="w-3 h-3 ml-0.5 opacity-60"/>:<EyeOff className="w-3 h-3 ml-0.5 opacity-50"/>}
              </button>
            );})()}
            <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border bg-green-700 border-green-800 text-white font-semibold">
              <Banknote className="w-3.5 h-3.5"/><span>รวมยอดชำระ</span><span>{fmtMoney(grandBadgePaidTotal)}</span>
            </div>
          </div>
        )}

        {/* ── Badge: due ────────────────────────────────────────────── */}
        {tab==="due"&&(
          <div className="bg-orange-50/60 border-b border-orange-200 px-4 py-2 flex flex-wrap items-center gap-2">
            {DUE_BADGE_ITEMS.map(({key,label,icon})=>{const isOn=dueVis[key];const val=grandBadgeDue[key as keyof MoneyBreakdown];return(
              <button key={key} type="button" onClick={()=>setDueVis((p)=>({...p,[key]:!p[key]}))}
                title={isOn?`ซ่อน${label}`:`แสดง${label}`}
                className={["flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border transition-colors",isOn?"bg-orange-100 border-orange-300 text-orange-800 hover:bg-orange-200":"bg-gray-100 border-gray-200 text-gray-400 hover:bg-gray-200"].join(" ")}>
                {icon}<span>{label}</span>
                <span className={["font-semibold ml-0.5",isOn?"":"text-gray-400"].join(" ")}>{fmtMoney(val)}</span>
                {isOn?<Eye className="w-3 h-3 ml-0.5 opacity-60"/>:<EyeOff className="w-3 h-3 ml-0.5 opacity-50"/>}
              </button>
            );})}
            <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border bg-orange-700 border-orange-800 text-white font-semibold">
              <Banknote className="w-3.5 h-3.5"/><span>รวม</span><span>{fmtMoney(computeDueTotal(grandBadgeDue,dueVis))}</span>
            </div>
          </div>
        )}

        {/* ── Badge: notYetDue ──────────────────────────────────────── */}
        {tab==="notYetDue"&&(
          <div className="bg-blue-50/60 border-b border-blue-200 px-4 py-2 flex flex-wrap items-center gap-2">
            {NOT_YET_DUE_BADGE_ITEMS.map(({key,label,icon})=>{const isOn=notYetDueVis[key];const val=grandBadgeNotYetDue[key as keyof MoneyBreakdown];return(
              <button key={key} type="button" onClick={()=>setNotYetDueVis((p)=>({...p,[key]:!p[key]}))}
                title={isOn?`ซ่อน${label}`:`แสดง${label}`}
                className={["flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border transition-colors",isOn?"bg-blue-100 border-blue-300 text-blue-800 hover:bg-blue-200":"bg-gray-100 border-gray-200 text-gray-400 hover:bg-gray-200"].join(" ")}>
                            {icon}<span>{label}</span>
                <span className={["font-semibold ml-0.5",isOn?"":"text-gray-400"].join(" ")}>{fmtMoney(val)}</span>
                {isOn?<Eye className="w-3 h-3 ml-0.5 opacity-60"/>:<EyeOff className="w-3 h-3 ml-0.5 opacity-50"/>}
              </button>
            );})}
            <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border bg-blue-700 border-blue-800 text-white font-semibold">
              <Banknote className="w-3.5 h-3.5" />
              <span>รวม</span>
              <span>{fmtMoney(computeNotYetDueTotal(grandBadgeNotYetDue, notYetDueVis))}</span>
            </div>
          </div>
        )}
      </div>
        {/* ── Combined Badge Panel (outside scroll) ─────────────────── */}
        {tab==="combined"&&canView&&!query.isLoading&&!query.error&&rows.length>0&&(
          <CombinedBadgePanel
            grandTotal={combinedGrandTotal}
            hiddenBuckets={hiddenBuckets}
            paidVis={paidVis} setPaidVis={setPaidVis}
            targetVis={targetVis} setTargetVis={setTargetVis}
            dueVis={dueVis} setDueVis={setDueVis}
            notYetDueVis={notYetDueVis} setNotYetDueVis={setNotYetDueVis}
            installVis={installVis} setInstallVis={setInstallVis}
            showBadDebtSale={showBadDebtSale} setShowBadDebtSale={setShowBadDebtSale}
          />
        )}
        {/* ── Table area ────────────────────────────────────────────── */}
        <div className="flex-1 min-h-0 overflow-x-auto overflow-y-auto">
          {!canView?(<div className="flex items-center justify-center h-full text-gray-400 text-sm">คุณไม่มีสิทธิ์ดูข้อมูลนี้</div>)
          :query.isLoading?(<div className="flex items-center justify-center h-full gap-2 text-gray-400"><Spinner className="w-5 h-5"/><span className="text-sm">กำลังโหลด...</span></div>)
          :query.error?(<div className="flex flex-col items-center justify-center h-full gap-3 text-red-500"><span className="text-sm">โหลดข้อมูลล้มเหลว: {query.error.message}</span><Button variant="outline" size="sm" onClick={()=>query.refetch()}>ลองใหม่</Button></div>)
          :rows.length===0?(<div className="flex items-center justify-center h-full text-gray-400 text-sm">ไม่มีข้อมูล</div>)
          :tab==="combined"&&combinedViewMode==="dueMonth"?(
            dueMonthQuery.isLoading?(<div className="flex items-center justify-center h-full gap-2 text-gray-400"><Spinner className="w-5 h-5"/><span className="text-sm">กำลังโหลด...</span></div>)
            :dueMonthQuery.error?(<div className="flex flex-col items-center justify-center h-full gap-3 text-red-500"><span className="text-sm">โหลดข้อมูลล้มเหลว: {dueMonthQuery.error.message}</span><Button variant="outline" size="sm" onClick={()=>dueMonthQuery.refetch()}>ลองใหม่</Button></div>)
            :(<DueMonthTable
              rows={dueMonthRows} allDueMonths={allDueMonths}
              hiddenRows={hiddenRows} toggleRow={toggleRow}
              hiddenSubRows={hiddenSubRows}
              sortDir={sortDir} onToggleSort={()=>setSortDir((d)=>d==="asc"?"desc":"asc")}
              stickyTop={0}
              paidVis={paidVis} targetVis={targetVis}
              dueVis={dueVis} notYetDueVis={notYetDueVis}
              installVis={installVis}
            />)
          ):tab==="combined"?(
            <CombinedTable
              rows={combinedRows} grandTotal={combinedGrandTotal}
              hiddenBuckets={hiddenBuckets} toggleBucket={toggleBucket}
              sortDir={sortDir} onToggleSort={()=>setSortDir((d)=>d==="asc"?"desc":"asc")}
              hiddenRows={hiddenRows} toggleRow={toggleRow}
              hiddenSubRows={hiddenSubRows}
              paidVis={paidVis} setPaidVis={setPaidVis}
              targetVis={targetVis} setTargetVis={setTargetVis}
              dueVis={dueVis} setDueVis={setDueVis}
              notYetDueVis={notYetDueVis} setNotYetDueVis={setNotYetDueVis}
              installVis={installVis} setInstallVis={setInstallVis}
              showBadDebtInstall={showBadDebtInstall} setShowBadDebtInstall={setShowBadDebtInstall}
              showBadDebtSale={showBadDebtSale} setShowBadDebtSale={setShowBadDebtSale}
              stickyTop={0}
            />
          ):(
            <SummaryTable
              tab={tab} rows={rows} grandTotal={grandTotal}
              hiddenBuckets={hiddenBuckets} toggleBucket={toggleBucket} toggleGroup={toggleGroup} toggleAll={toggleAll}
              paidVis={paidVis} setPaidVis={setPaidVis} targetVis={targetVis} dueVis={dueVis} notYetDueVis={notYetDueVis} installVis={installVis}
              showBadDebtInstall={showBadDebtInstall} setShowBadDebtInstall={setShowBadDebtInstall}
              showBadDebtSale={showBadDebtSale} setShowBadDebtSale={setShowBadDebtSale}
              sortDir={sortDir} onToggleSort={()=>setSortDir((d)=>d==="asc"?"desc":"asc")}
              hiddenRows={hiddenRows} toggleRow={toggleRow}
              stickyTop={0}
            />
          )}
        </div>
      </div>
    </AppShell>
  );
}

// ─── SummaryTable ─────────────────────────────────────────────────────────────
function SummaryTable({tab,rows,grandTotal,hiddenBuckets,toggleBucket,toggleGroup,toggleAll,paidVis,setPaidVis,targetVis,dueVis,notYetDueVis,installVis,sortDir,onToggleSort,hiddenRows,toggleRow,showBadDebtInstall,setShowBadDebtInstall,showBadDebtSale,setShowBadDebtSale,stickyTop}:{
  tab:TabKey;rows:SummaryRow[];grandTotal:GrandTotal;hiddenBuckets:Set<string>;
  toggleBucket:(b:string)=>void;toggleGroup:(g:ColGroup)=>void;toggleAll:()=>void;
  paidVis:Record<MoneyBadgeKey,boolean>;setPaidVis:React.Dispatch<React.SetStateAction<Record<MoneyBadgeKey,boolean>>>;targetVis:Record<MoneyBadgeKey,boolean>;
  dueVis:Record<DueBadgeKey,boolean>;notYetDueVis:Record<NotYetDueBadgeKey,boolean>;
  installVis:Record<"principal"|"interest"|"fee",boolean>;
  sortDir:SortDir;onToggleSort:()=>void;
  hiddenRows:Set<string>;toggleRow:(month:string)=>void;
  showBadDebtInstall:boolean;setShowBadDebtInstall:(v:boolean)=>void;
  showBadDebtSale:boolean;setShowBadDebtSale:(v:boolean)=>void;
  stickyTop:number;
}) {
  const isBadDebtExpanded=(b:string)=>tab==="paid"&&b==="หนี้เสีย";
  const bucketColSpan=(b:string)=>isBadDebtExpanded(b)?3:1;

  // cell value helpers
  const cellCountVal=(b:string,cell:SummaryCell|undefined)=>hiddenBuckets.has(b)?0:(cell?.contractCount??0);
  const cellCountDisplay=(_b:string,cell:SummaryCell|undefined)=>(cell?.contractCount??0);

  // target
  const cellTargetVal=(b:string,cell:SummaryCell|undefined)=>hiddenBuckets.has(b)?0:(cell?computeMoneyTotal(cell.target,{...targetVis,discount:false,overpaid:false}):0);
  const cellTargetDisplay=(_b:string,cell:SummaryCell|undefined)=>(cell?computeMoneyTotal(cell.target,{...targetVis,discount:false,overpaid:false}):0);

  // paid
  const cellPaidVal=(b:string,cell:SummaryCell|undefined)=>hiddenBuckets.has(b)?0:(cell?computeMoneyTotal(cell.paid,paidVis):0);
  const cellPaidDisplay=(_b:string,cell:SummaryCell|undefined)=>(cell?computeMoneyTotal(cell.paid,paidVis):0);
  // คอลัมน์ "ค่างวด" ของ bucket หนี้เสีย: ใช้ computeMoneyTotal เพื่อให้ badge toggle มีผล
  const cellPaidBadDebtInstallRaw=(_b:string,cell:SummaryCell|undefined)=>(cell?.paid.badDebtInstallment??0);
  // cellPaidBadDebtInstallVisible: ยอดที่แสดงในคอลัมน์ค่างวด (หักตาม badge ที่ปิดตา)
  const cellPaidBadDebtInstallVisible=(_b:string,cell:SummaryCell|undefined)=>(cell?computeMoneyTotal(cell.paid,paidVis):0);
  const cellPaidBadDebtRaw=(_b:string,cell:SummaryCell|undefined)=>(cell?.paid.badDebt??0);

  // due
  const cellDueVal=(b:string,cell:SummaryCell|undefined)=>hiddenBuckets.has(b)?0:(cell?computeDueTotal(cell.due,dueVis):0);
  const cellDueDisplay=(_b:string,cell:SummaryCell|undefined)=>(cell?computeDueTotal(cell.due,dueVis):0);
  const cellDueBadDebtInstallRaw=(_b:string,cell:SummaryCell|undefined)=>(cell?.due.total??0);

  // notYetDue
  const cellNotYetDueVal=(b:string,cell:SummaryCell|undefined)=>hiddenBuckets.has(b)?0:(cell?computeNotYetDueTotal(cell.notYetDue,notYetDueVis):0);
  const cellNotYetDueDisplay=(_b:string,cell:SummaryCell|undefined)=>(cell?computeNotYetDueTotal(cell.notYetDue,notYetDueVis):0);

  // installTotal — ใช้ installVis ในการคำนวณ
  function computeInstallVisTotal(m:MoneyBreakdown):number {
    return (installVis.principal?m.principal:0)+(installVis.interest?m.interest:0)+(installVis.fee?m.fee:0);
  }
  const cellInstallVal=(b:string,cell:SummaryCell|undefined)=>hiddenBuckets.has(b)?0:(cell?computeInstallVisTotal(cell.installTotal):0);
  const cellInstallDisplay=(_b:string,cell:SummaryCell|undefined)=>(cell?computeInstallVisTotal(cell.installTotal):0);
  const gtInstallVal=(b:string)=>{const bt=grandTotal.bucketTotals[b];return hiddenBuckets.has(b)?0:(bt?computeInstallVisTotal(bt.installTotal):0);};

  // grand total helpers
  const gtCountVal=(b:string)=>{const bt=grandTotal.bucketTotals[b];return hiddenBuckets.has(b)?0:(bt?.count??0);};
  const gtTargetVal=(b:string)=>{const bt=grandTotal.bucketTotals[b];return hiddenBuckets.has(b)?0:(bt?computeMoneyTotal(bt.target,{...targetVis,discount:false,overpaid:false}):0);};
  const gtPaidVal=(b:string)=>{const bt=grandTotal.bucketTotals[b];return hiddenBuckets.has(b)?0:(bt?computeMoneyTotal(bt.paid,paidVis):0);};
  const gtPaidBadDebtInstallRaw=(b:string)=>{const bt=grandTotal.bucketTotals[b];return hiddenBuckets.has(b)?0:(bt?.paid.badDebtInstallment??0);};
  // gtPaidBadDebtInstallVisible: ยอดค่างวดหนี้เสียที่แสดงตาม badge ที่เปิดอยู่
  const gtPaidBadDebtInstallVisible=(b:string)=>{const bt=grandTotal.bucketTotals[b];return hiddenBuckets.has(b)?0:(bt?computeMoneyTotal(bt.paid,paidVis):0);};
  const gtPaidBadDebtRaw=(b:string)=>{const bt=grandTotal.bucketTotals[b];return hiddenBuckets.has(b)?0:(bt?.paid.badDebt??0);};
  const gtPaidBadDebtInstall=(b:string)=>paidVis.badDebtInstallment?gtPaidBadDebtInstallRaw(b):0;
  const gtPaidBadDebt=(b:string)=>showBadDebtSale?gtPaidBadDebtRaw(b):0;
  const gtDueVal=(b:string)=>{const bt=grandTotal.bucketTotals[b];return hiddenBuckets.has(b)?0:(bt?computeDueTotal(bt.due,dueVis):0);};
  const gtDueBadDebtInstallRaw=(b:string)=>{const bt=grandTotal.bucketTotals[b];return hiddenBuckets.has(b)?0:(bt?.due.total??0);};
  const gtDueBadDebtInstall=(b:string)=>paidVis.badDebtInstallment?gtDueBadDebtInstallRaw(b):0;
  const gtNotYetDueVal=(b:string)=>{const bt=grandTotal.bucketTotals[b];return hiddenBuckets.has(b)?0:(bt?computeNotYetDueTotal(bt.notYetDue,notYetDueVis):0);};

  // ── Visible buckets per tab ─────────────────────────────────────────────
  const HIDDEN_BUCKETS_BY_TAB: Record<string,string[]> = {
    target:   [],
    due:      ["สิ้นสุดสัญญา","หนี้เสีย"],
    notYetDue:["ระงับสัญญา","สิ้นสุดสัญญา","หนี้เสีย"],
  };
  const tabHiddenBuckets = new Set(HIDDEN_BUCKETS_BY_TAB[tab] ?? []);
  const visibleGroups: ColGroup[] = COL_GROUPS.map(g=>({
    ...g,
    buckets: (g.buckets as string[]).filter(b=>!tabHiddenBuckets.has(b)) as DebtBucket[],
  })).filter(g=>g.buckets.length>0);
  const normalBuckets=COL_GROUPS[0].buckets as readonly string[];
  const suspectBuckets=COL_GROUPS[1].buckets as readonly string[];

  function rowNormalCount(row:SummaryRow):number{return normalBuckets.reduce((s,b)=>s+cellCountVal(b,row.buckets[b]),0);}
  function rowNormalTarget(row:SummaryRow):number{return normalBuckets.reduce((s,b)=>s+cellTargetVal(b,row.buckets[b]),0);}
  function rowNormalPaid(row:SummaryRow):number{return normalBuckets.reduce((s,b)=>s+cellPaidVal(b,row.buckets[b]),0);}
  function rowNormalDue(row:SummaryRow):number{return normalBuckets.reduce((s,b)=>s+cellDueVal(b,row.buckets[b]),0);}
  function rowNormalNotYetDue(row:SummaryRow):number{return normalBuckets.reduce((s,b)=>s+cellNotYetDueVal(b,row.buckets[b]),0);}
  function rowSuspectCount(row:SummaryRow):number{return suspectBuckets.reduce((s,b)=>s+cellCountVal(b,row.buckets[b]),0);}
  function rowSuspectTarget(row:SummaryRow):number{return suspectBuckets.reduce((s,b)=>s+cellTargetVal(b,row.buckets[b]),0);}
  function rowSuspectPaid(row:SummaryRow):number{return suspectBuckets.reduce((s,b)=>s+cellPaidVal(b,row.buckets[b]),0);}
  function rowSuspectDue(row:SummaryRow):number{return suspectBuckets.reduce((s,b)=>s+cellDueVal(b,row.buckets[b]),0);}
  function rowSuspectNotYetDue(row:SummaryRow):number{return suspectBuckets.reduce((s,b)=>s+cellNotYetDueVal(b,row.buckets[b]),0);}

  const gtNormalCount=normalBuckets.reduce((s,b)=>s+gtCountVal(b),0);
  const gtNormalTarget=normalBuckets.reduce((s,b)=>s+gtTargetVal(b),0);
  const gtNormalPaid=normalBuckets.reduce((s,b)=>s+gtPaidVal(b),0);
  const gtNormalDue=normalBuckets.reduce((s,b)=>s+gtDueVal(b),0);
  const gtNormalNotYetDue=normalBuckets.reduce((s,b)=>s+gtNotYetDueVal(b),0);
  const gtSuspectCount=suspectBuckets.reduce((s,b)=>s+gtCountVal(b),0);
  const gtSuspectTarget=suspectBuckets.reduce((s,b)=>s+gtTargetVal(b),0);
  const gtSuspectPaid=suspectBuckets.reduce((s,b)=>s+gtPaidVal(b),0);
  const gtSuspectDue=suspectBuckets.reduce((s,b)=>s+gtDueVal(b),0);
  const gtSuspectNotYetDue=suspectBuckets.reduce((s,b)=>s+gtNotYetDueVal(b),0);

  function rowContractTotal(row:SummaryRow):number{return DEBT_BUCKETS.reduce((s,b)=>s+cellCountVal(b,row.buckets[b]),0);}
  const gtContractTotal=DEBT_BUCKETS.reduce((s,b)=>s+gtCountVal(b),0);

  function rowTargetTotal(row:SummaryRow):number{
    if(hiddenRows.has(row.approveMonth))return 0;
    return DEBT_BUCKETS.reduce((s,b)=>{if(hiddenBuckets.has(b))return s;const cell=row.buckets[b];if(!cell)return s;return s+computeMoneyTotal(cell.target,{...targetVis,discount:false,overpaid:false});},0);
  }
  function rowPaidTotal(row:SummaryRow):number{
    if(hiddenRows.has(row.approveMonth))return 0;
    return DEBT_BUCKETS.reduce((s,b)=>{
      if(hiddenBuckets.has(b))return s;const cell=row.buckets[b];if(!cell)return s;
      if(b==="หนี้เสีย"){return s+computeMoneyTotal(cell.paid,paidVis)+(showBadDebtSale?(cell.paid.badDebt??0):0);}
      return s+computeMoneyTotal(cell.paid,paidVis);
    },0);
  }
  function rowDueTotal(row:SummaryRow):number{
    if(hiddenRows.has(row.approveMonth))return 0;
    return DEBT_BUCKETS.reduce((s,b)=>{
      if(hiddenBuckets.has(b))return s;const cell=row.buckets[b];if(!cell)return s;
      if(b==="หนี้เสีย"){return s+(paidVis.badDebtInstallment?(cell.due.total??0):0);}
      return s+computeDueTotal(cell.due,dueVis);
    },0);
  }
  function rowNotYetDueTotal(row:SummaryRow):number{
    if(hiddenRows.has(row.approveMonth))return 0;
    return DEBT_BUCKETS.reduce((s,b)=>{if(hiddenBuckets.has(b))return s;const cell=row.buckets[b];if(!cell)return s;return s+computeNotYetDueTotal(cell.notYetDue,notYetDueVis);},0);
  }
  function rowInstallTotal(row:SummaryRow):number{
    if(hiddenRows.has(row.approveMonth))return 0;
    return DEBT_BUCKETS.reduce((s,b)=>{if(hiddenBuckets.has(b))return s;const cell=row.buckets[b];if(!cell)return s;return s+computeInstallVisTotal(cell.installTotal);},0);
  }

  const gtTargetTotal=DEBT_BUCKETS.reduce((s,b)=>{if(hiddenBuckets.has(b))return s;const bt=grandTotal.bucketTotals[b];if(!bt)return s;return s+computeMoneyTotal(bt.target,{...targetVis,discount:false,overpaid:false});},0);
  const gtPaidTotal=DEBT_BUCKETS.reduce((s,b)=>{
    if(hiddenBuckets.has(b))return s;const bt=grandTotal.bucketTotals[b];if(!bt)return s;
    if(b==="หนี้เสีย"){return s+computeMoneyTotal(bt.paid,paidVis)+(showBadDebtSale?(bt.paid.badDebt??0):0);}
    return s+computeMoneyTotal(bt.paid,paidVis);
  },0);
  const gtDueTotal=DEBT_BUCKETS.reduce((s,b)=>{
    if(hiddenBuckets.has(b))return s;const bt=grandTotal.bucketTotals[b];if(!bt)return s;
    if(b==="หนี้เสีย"){return s+(paidVis.badDebtInstallment?(bt.due.total??0):0);}
    return s+computeDueTotal(bt.due,dueVis);
  },0);
  const gtNotYetDueTotal=DEBT_BUCKETS.reduce((s,b)=>{if(hiddenBuckets.has(b))return s;const bt=grandTotal.bucketTotals[b];if(!bt)return s;return s+computeNotYetDueTotal(bt.notYetDue,notYetDueVis);},0);
  const gtInstallTotal=DEBT_BUCKETS.reduce((s,b)=>{if(hiddenBuckets.has(b))return s;const bt=grandTotal.bucketTotals[b];if(!bt)return s;return s+computeInstallVisTotal(bt.installTotal);},0);

  // render helpers
  function renderCount(v:number){return v>0?(<span className="inline-flex items-center justify-center bg-slate-200 text-slate-700 rounded-full px-2.5 py-0.5 text-xs font-bold">{v.toLocaleString()}</span>):(<span className="text-gray-300">—</span>);}
  function renderMoney(v:number,colorClass:string){return<span className={v>0?colorClass:"text-gray-300"}>{v>0?fmtMoney(v):"0.00"}</span>;}

  const SortIcon=sortDir==="asc"?ArrowUp:ArrowDown;

  // second column label by tab
  const col2Label=tab==="count"?"สัญญา":tab==="installTotal"?"ยอดผ่อนรวม":tab==="target"?"เป้าเก็บหนี้":tab==="paid"?"ยอดชำระ":tab==="due"?"หนี้ค้างชำระ":"ยังไม่ถึงกำหนด";
  const col2Color=tab==="count"?"bg-slate-700":tab==="installTotal"?"bg-purple-700":tab==="target"?"bg-indigo-700":tab==="paid"?"bg-green-700":tab==="due"?"bg-orange-700":"bg-blue-700";

  const minWidth=useMemo(()=>{
    let w=130+110;
    for(const g of COL_GROUPS){
      for(const b of g.buckets)w+=isBadDebtExpanded(b)?360:120;
      if(g.hasSubtotal)w+=120;
    }
    return w;
  },[tab]);// eslint-disable-line react-hooks/exhaustive-deps

  return(
    <>
    <table className="w-full text-sm border-collapse" style={{minWidth:`${minWidth}px`}}>
      <thead className="sticky z-20" style={{top:`${stickyTop}px`}}>
        {/* ── Row 1: group headers ──────────────────────────────────── */}
        <tr>
          <th rowSpan={3} className="sticky left-0 z-30 px-3 py-2 text-left font-semibold whitespace-nowrap bg-slate-800 text-white border-r border-slate-600 min-w-[130px]">
            <div className="flex items-center gap-1.5">
              <button type="button" onClick={onToggleSort} className="flex items-center gap-1 hover:opacity-80 transition-opacity" title={sortDir==="asc"?"เรียงใหม่→เก่า":"เรียงเก่า→ใหม่"}>
                เดือน-ปีที่อนุมัติ<SortIcon className="w-3.5 h-3.5 text-slate-300"/>
              </button>
            </div>
          </th>
          <th rowSpan={3} className={`sticky left-[130px] z-30 px-3 py-2 text-right font-semibold whitespace-nowrap ${col2Color} text-white border-r border-white/20 min-w-[110px]`}>
            {col2Label}
          </th>
          {visibleGroups.map((g)=>{
            const bucketSpan=g.buckets.reduce((a,b)=>a+bucketColSpan(b),0);
            const span=bucketSpan+(g.hasSubtotal?1:0);
            if(!g.label){
              return g.buckets.map((b)=>{
                if(isBadDebtExpanded(b)){
                  return(
                    <th key={b} rowSpan={3} colSpan={3}
                      className={`px-0 py-0 text-center text-xs font-semibold text-white whitespace-nowrap min-w-[360px] border-r border-white/20 ${bucketHeaderBg(b)}`}
                      style={{verticalAlign:'top'}}>
                      <div className="flex items-center justify-center gap-1 px-2 py-3">
                        <button type="button" onClick={()=>toggleBucket(b)} className="hover:opacity-80 transition-opacity">
                          {hiddenBuckets.has(b)?<EyeOff className="w-3 h-3"/>:<Eye className="w-3 h-3"/>}
                        </button>
                        <span className={`inline-block px-1.5 py-0.5 rounded-full text-[10px] border ${bucketPillClasses(b)}`}>{b}</span>
                      </div>
                      <div className="flex border-t border-white/20">
                        <button type="button" onClick={()=>{const PAID_KEYS=["principal","interest","fee","penalty","unlockFee","discount","overpaid"] as const;const anyOn=PAID_KEYS.some(k=>paidVis[k]);setPaidVis(p=>({...p,...Object.fromEntries(PAID_KEYS.map(k=>[k,!anyOn]))}));}}
                          className={`flex-1 flex items-center justify-center gap-1 px-2 py-1.5 text-[10px] font-semibold border-r border-white/10 transition-colors hover:bg-white/10 ${(["principal","interest","fee","penalty","unlockFee","discount","overpaid"] as const).some(k=>paidVis[k])?"text-white/90":"text-white/40"}`}>
                          {(["principal","interest","fee","penalty","unlockFee","discount","overpaid"] as const).some(k=>paidVis[k])?<Eye className="w-2.5 h-2.5"/>:<EyeOff className="w-2.5 h-2.5"/>}ค่างวด
                        </button>
                        <button type="button" onClick={()=>setShowBadDebtSale(!showBadDebtSale)}
                          className={`flex-1 flex items-center justify-center gap-1 px-2 py-1.5 text-[10px] font-semibold border-r border-white/10 transition-colors hover:bg-white/10 ${showBadDebtSale?"text-red-200":"text-red-200/40"}`}>
                          {showBadDebtSale?<Eye className="w-2.5 h-2.5"/>:<EyeOff className="w-2.5 h-2.5"/>}ขายเครื่อง
                        </button>
                        <div className="flex-1 px-2 py-1.5 text-center text-[10px] font-semibold text-white/80">รวม</div>
                      </div>
                    </th>
                  );
                }
                return(
                  <th key={b} rowSpan={3} colSpan={1}
                    onClick={()=>toggleBucket(b)}
                    className={`px-2 py-3 align-middle text-center text-xs font-semibold text-white whitespace-nowrap min-w-[120px] border-r border-white/20 cursor-pointer hover:opacity-80 transition-opacity ${bucketHeaderBg(b)}`}>
                    <div className="flex flex-col items-center gap-1">
                      {hiddenBuckets.has(b)?<EyeOff className="w-3 h-3"/>:<Eye className="w-3 h-3"/>}
                      <span className={`inline-block px-1.5 py-0.5 rounded-full text-[10px] border ${bucketPillClasses(b)}`}>{b}</span>
                    </div>
                  </th>
                );
              });
            }
            return(
              <th key={g.key} colSpan={span}
                className={`px-2 py-1.5 text-center text-xs font-semibold text-white whitespace-nowrap border-r border-white/20 ${g.headerBg}`}>
                <div className="flex items-center justify-center gap-1">
                  <button type="button" onClick={()=>toggleGroup(g)} className="hover:opacity-80 transition-opacity" title="เปิด/ปิดกลุ่ม">
                    {g.buckets.every((b)=>hiddenBuckets.has(b))?<EyeOff className="w-3 h-3"/>:<Eye className="w-3 h-3"/>}
                  </button>
                  {g.label}
                </div>
              </th>
            );
          })}

        </tr>
        {/* ── Row 2: bucket headers (for groups with subtotal) ──────── */}
        <tr>
          {visibleGroups.map((g)=>{
            if(!g.label)return null;
            return(
              <React.Fragment key={g.key}>
                {g.buckets.map((b)=>(
                  <th key={b} onClick={()=>toggleBucket(b)}
                    className={`px-2 py-2 text-center text-xs font-semibold text-white whitespace-nowrap min-w-[120px] border-r border-white/20 cursor-pointer hover:opacity-80 transition-opacity ${bucketHeaderBg(b)}`}>
                    <div className="flex flex-col items-center gap-0.5">
                      {hiddenBuckets.has(b)?<EyeOff className="w-3 h-3"/>:<Eye className="w-3 h-3"/>}
                      <span className={`inline-block px-1.5 py-0.5 rounded-full text-[10px] border ${bucketPillClasses(b)}`}>{b}</span>
                    </div>
                  </th>
                ))}
                <th className={`px-2 py-2 text-center text-xs font-semibold text-white whitespace-nowrap min-w-[120px] border-r border-white/20 ${g.headerBg}`}>รวม</th>
              </React.Fragment>
            );
          })}
        </tr>
        {/* ── Row 3: empty (for rowSpan alignment) ─────────────────── */}
        <tr className="h-0"/>
      </thead>
      <tbody>
        {rows.map((row)=>{
          const isHiddenRow=hiddenRows.has(row.approveMonth);
          return(
            <tr key={row.approveMonth} className={`border-b border-gray-100 hover:bg-blue-50/20 transition-colors ${isHiddenRow?"opacity-60":""}`}>
              {/* เดือน-ปี */}
              <td className="sticky left-0 z-10 px-3 py-2.5 text-sm font-semibold whitespace-nowrap bg-white border-r border-gray-200 min-w-[130px]">
                <div className="flex items-center gap-1.5">
                  <button type="button" onClick={()=>toggleRow(row.approveMonth)} title={isHiddenRow?"แสดงแถวนี้":"ซ่อนแถวนี้"} className="hover:opacity-70 transition-opacity">
                    {isHiddenRow?<EyeOff className="w-3.5 h-3.5 text-gray-400"/>:<Eye className="w-3.5 h-3.5 text-gray-400"/>}
                  </button>
                  <span className="text-gray-800">{fmtMonthYear(row.approveMonth)}</span>
                </div>
              </td>
              {/* รวมคอลัมน์ 2 */}
              <td className="sticky left-[130px] z-10 px-3 py-2.5 text-right bg-white border-r border-gray-200 min-w-[110px]">
                {tab==="count"?renderCount(isHiddenRow?0:rowContractTotal(row))
                :tab==="installTotal"?renderMoney(isHiddenRow?0:rowInstallTotal(row),"text-purple-800 font-semibold")
                :tab==="target"?renderMoney(isHiddenRow?0:rowTargetTotal(row),"text-indigo-800 font-semibold")
                :tab==="paid"?renderMoney(isHiddenRow?0:rowPaidTotal(row),"text-green-800 font-semibold")
                :tab==="due"?renderMoney(isHiddenRow?0:rowDueTotal(row),"text-orange-800 font-semibold")
                :renderMoney(isHiddenRow?0:rowNotYetDueTotal(row),"text-blue-800 font-semibold")}
              </td>
              {/* Bucket cells */}
              {visibleGroups.map((g,gi)=>(
                <React.Fragment key={g.key}>
                  {g.buckets.map((b)=>{
                    const cell=row.buckets[b];const cellBg=bucketCellBg(b);
                    const isBucketHidden=hiddenBuckets.has(b);
                    const isDimmed=isHiddenRow||isBucketHidden;

                    if(tab==="count"){
                      const displayV=cellCountDisplay(b,cell);
                      if(isDimmed)return<td key={b} className={`px-3 py-2.5 text-right ${cellBg}`}><span className="inline-flex items-center justify-center bg-slate-200 text-slate-400 rounded-full px-2.5 py-0.5 text-xs font-bold">{displayV.toLocaleString()}</span></td>;
                      return<td key={b} className={`px-3 py-2.5 text-right ${cellBg}`}>{renderCount(cellCountVal(b,cell))}</td>;
                    }
                    if(tab==="target"){
                      const displayV=cellTargetDisplay(b,cell);
                      if(isDimmed)return<td key={b} className={`px-3 py-2.5 text-right ${cellBg}`}><span className="text-gray-400">{fmtMoney(displayV)}</span></td>;
                      return<td key={b} className={`px-3 py-2.5 text-right ${cellBg}`}>{renderMoney(cellTargetVal(b,cell),"text-indigo-800 font-medium")}</td>;
                    }
                    if(tab==="paid"){
                      if(isBadDebtExpanded(b)){
                        // ค่างวด: ยอดที่แสดงตาม badge ที่เปิดอยู่ (computeMoneyTotal)
                        const installDisplay=cellPaidBadDebtInstallVisible(b,cell); // ยอดที่หักตาม badge แล้ว
                        const installRaw=cellPaidBadDebtInstallRaw(b,cell); // ยอดดิบ (ใช้แสดงตอน dimmed)
                        const saleDisplay=cellPaidBadDebtRaw(b,cell);
                        const saleRaw=isDimmed?0:saleDisplay;
                        const install=isDimmed?0:installDisplay;
                        const sale=showBadDebtSale?saleRaw:0;
                        const total=install+sale;
                        if(isDimmed)return(
                          <React.Fragment key={b}>
                            <td className={`px-3 py-2.5 text-right ${cellBg}`}><span className="text-gray-400">{fmtMoney(installRaw)}</span></td>
                            <td className={`px-3 py-2.5 text-right ${cellBg}`}><span className="text-gray-400">{fmtMoney(saleDisplay)}</span></td>
                            <td className={`px-3 py-2.5 text-right font-semibold ${cellBg}`}><span className="text-gray-400">{fmtMoney(installRaw+saleDisplay)}</span></td>
                          </React.Fragment>
                        );
                        return(
                          <React.Fragment key={b}>
                            <td className={`px-3 py-2.5 text-right ${cellBg}`}>{install===0?<span className="text-gray-300">{fmtMoney(installRaw)}</span>:renderMoney(install,"text-green-800 font-medium")}</td>
                            <td className={`px-3 py-2.5 text-right ${cellBg}`}>{!showBadDebtSale?<span className="text-gray-300">{fmtMoney(saleDisplay)}</span>:renderMoney(sale,"text-red-700 font-medium")}</td>
                            <td className={`px-3 py-2.5 text-right font-semibold ${cellBg}`}>{renderMoney(total,"text-gray-800")}</td>
                          </React.Fragment>
                        );
                      }
                      const displayV=cellPaidDisplay(b,cell);
                      if(isDimmed)return<td key={b} className={`px-3 py-2.5 text-right ${cellBg}`}><span className="text-gray-400">{fmtMoney(displayV)}</span></td>;
                      return<td key={b} className={`px-3 py-2.5 text-right ${cellBg}`}>{renderMoney(cellPaidVal(b,cell),"text-green-800 font-medium")}</td>;
                    }
                    if(tab==="due"){
                      if(isBadDebtExpanded(b)){
                        const installDisplay=cellDueBadDebtInstallRaw(b,cell);
                        const installRaw=isDimmed?0:installDisplay;
                        const install=paidVis.badDebtInstallment?installRaw:0;
                        if(isDimmed)return(
                          <React.Fragment key={b}>
                            <td className={`px-3 py-2.5 text-right ${cellBg}`}><span className="text-gray-400">{fmtMoney(installDisplay)}</span></td>
                            <td className={`px-3 py-2.5 text-right ${cellBg}`}><span className="text-gray-400">0.00</span></td>
                            <td className={`px-3 py-2.5 text-right font-semibold ${cellBg}`}><span className="text-gray-400">{fmtMoney(installDisplay)}</span></td>
                          </React.Fragment>
                        );
                        return(
                          <React.Fragment key={b}>
                            <td className={`px-3 py-2.5 text-right ${cellBg}`}>{!paidVis.badDebtInstallment?<span className="text-gray-300">{fmtMoney(installDisplay)}</span>:renderMoney(install,"text-orange-800 font-medium")}</td>
                            <td className={`px-3 py-2.5 text-right ${cellBg}`}><span className="text-gray-300">0.00</span></td>
                            <td className={`px-3 py-2.5 text-right font-semibold ${cellBg}`}>{renderMoney(install,"text-gray-800")}</td>
                          </React.Fragment>
                        );
                      }
                      const displayV=cellDueDisplay(b,cell);
                      if(isDimmed)return<td key={b} className={`px-3 py-2.5 text-right ${cellBg}`}><span className="text-gray-400">{fmtMoney(displayV)}</span></td>;
                      return<td key={b} className={`px-3 py-2.5 text-right ${cellBg}`}>{renderMoney(cellDueVal(b,cell),"text-orange-800 font-medium")}</td>;
                    }
                    if(tab==="installTotal"){
                      const displayV=cellInstallDisplay(b,cell);
                      if(isDimmed)return<td key={b} className={`px-3 py-2.5 text-right ${cellBg}`}><span className="text-gray-400">{fmtMoney(displayV)}</span></td>;
                      return<td key={b} className={`px-3 py-2.5 text-right ${cellBg}`}>{renderMoney(cellInstallVal(b,cell),"text-purple-800 font-medium")}</td>;
                    }
                    // notYetDue tab
                    const displayV=cellNotYetDueDisplay(b,cell);
                    if(isDimmed)return<td key={b} className={`px-3 py-2.5 text-right ${cellBg}`}><span className="text-gray-400">{fmtMoney(displayV)}</span></td>;
                    return<td key={b} className={`px-3 py-2.5 text-right ${cellBg}`}>{renderMoney(cellNotYetDueVal(b,cell),"text-blue-800 font-medium")}</td>;
                  })}
                  {/* Subtotal column */}
                  {g.hasSubtotal&&(()=>{
                    const subBg=gi===0?"bg-green-50/60":"bg-orange-50/60";
                    const buckets=gi===0?normalBuckets:suspectBuckets;
                    if(tab==="count"){
                      const calcV=isHiddenRow?0:(gi===0?rowNormalCount(row):rowSuspectCount(row));
                      if(isHiddenRow){const displayV=buckets.reduce((s,b)=>s+(row.buckets[b]?.contractCount??0),0);return<td className={`px-3 py-2.5 text-right font-bold ${subBg} border-r border-gray-200`}><span className="inline-flex items-center justify-center bg-slate-200 text-slate-400 rounded-full px-2.5 py-0.5 text-xs font-bold">{displayV.toLocaleString()}</span></td>;}
                      return<td className={`px-3 py-2.5 text-right font-bold ${subBg} border-r border-gray-200`}>{renderCount(calcV)}</td>;
                    }
                    if(tab==="target"){
                      const calcV=isHiddenRow?0:(gi===0?rowNormalTarget(row):rowSuspectTarget(row));
                      if(isHiddenRow){const displayV=buckets.reduce((s,b)=>{const c=row.buckets[b];return s+(c?computeMoneyTotal(c.target,{...targetVis,discount:false,overpaid:false}):0);},0);return<td className={`px-3 py-2.5 text-right font-bold ${subBg} border-r border-gray-200`}><span className="text-gray-400">{fmtMoney(displayV)}</span></td>;}
                      return<td className={`px-3 py-2.5 text-right font-bold ${subBg} border-r border-gray-200`}>{renderMoney(calcV,"text-indigo-900")}</td>;
                    }
                    if(tab==="paid"){
                      const calcV=isHiddenRow?0:(gi===0?rowNormalPaid(row):rowSuspectPaid(row));
                      if(isHiddenRow){const displayV=buckets.reduce((s,b)=>{const c=row.buckets[b];return s+(c?computeMoneyTotal(c.paid,paidVis):0);},0);return<td className={`px-3 py-2.5 text-right font-bold ${subBg} border-r border-gray-200`}><span className="text-gray-400">{fmtMoney(displayV)}</span></td>;}
                      return<td className={`px-3 py-2.5 text-right font-bold ${subBg} border-r border-gray-200`}>{renderMoney(calcV,"text-green-900")}</td>;
                    }
                    if(tab==="due"){
                      const calcV=isHiddenRow?0:(gi===0?rowNormalDue(row):rowSuspectDue(row));
                      if(isHiddenRow){const displayV=buckets.reduce((s,b)=>{const c=row.buckets[b];return s+(c?computeDueTotal(c.due,dueVis):0);},0);return<td className={`px-3 py-2.5 text-right font-bold ${subBg} border-r border-gray-200`}><span className="text-gray-400">{fmtMoney(displayV)}</span></td>;}
                      return<td className={`px-3 py-2.5 text-right font-bold ${subBg} border-r border-gray-200`}>{renderMoney(calcV,"text-orange-900")}</td>;
                    }
                    if(tab==="installTotal"){
                      const calcV=isHiddenRow?0:buckets.reduce((s,b)=>s+cellInstallVal(b,row.buckets[b]),0);
                      if(isHiddenRow){const displayV=buckets.reduce((s,b)=>s+cellInstallDisplay(b,row.buckets[b]),0);return<td className={`px-3 py-2.5 text-right font-bold ${subBg} border-r border-gray-200`}><span className="text-gray-400">{fmtMoney(displayV)}</span></td>;}
                      return<td className={`px-3 py-2.5 text-right font-bold ${subBg} border-r border-gray-200`}>{renderMoney(calcV,"text-purple-900")}</td>;
                    }
                    // notYetDue
                    const calcV=isHiddenRow?0:(gi===0?rowNormalNotYetDue(row):rowSuspectNotYetDue(row));
                    if(isHiddenRow){const displayV=buckets.reduce((s,b)=>{const c=row.buckets[b];return s+(c?computeNotYetDueTotal(c.notYetDue,notYetDueVis):0);},0);return<td className={`px-3 py-2.5 text-right font-bold ${subBg} border-r border-gray-200`}><span className="text-gray-400">{fmtMoney(displayV)}</span></td>;}
                    return<td className={`px-3 py-2.5 text-right font-bold ${subBg} border-r border-gray-200`}>{renderMoney(calcV,"text-blue-900")}</td>;
                  })()}
                </React.Fragment>
              ))}
              <td className="px-2 py-2.5 bg-white"/>
            </tr>
          );
        })}
      </tbody>
      {/* ── Sticky Grand Total tfoot ──────────────────────────────── */}
      <tfoot className="sticky bottom-0 z-20 border-t-2 border-slate-400 bg-slate-100 shadow-[0_-2px_8px_rgba(0,0,0,0.12)]">
          <tr>
            <td className="sticky left-0 z-20 px-3 py-2.5 text-slate-800 whitespace-nowrap border-r border-slate-300 bg-slate-200 min-w-[130px]">รวมทั้งหมด</td>
            <td className="sticky left-[130px] z-20 px-3 py-2.5 text-right border-r border-slate-300 bg-slate-200 min-w-[110px]">
              {tab==="count"?(<span className="inline-flex items-center justify-center bg-slate-400 text-white rounded-full px-2.5 py-0.5 text-xs font-bold">{gtContractTotal.toLocaleString()}</span>)
              :tab==="installTotal"?renderMoney(gtInstallTotal,"text-purple-900")
              :tab==="target"?renderMoney(gtTargetTotal,"text-indigo-900")
              :tab==="paid"?renderMoney(gtPaidTotal,"text-green-900")
              :tab==="due"?renderMoney(gtDueTotal,"text-orange-900")
              :renderMoney(gtNotYetDueTotal,"text-blue-900")}
            </td>
            {visibleGroups.map((g,gi)=>(
              <React.Fragment key={g.key}>
                {g.buckets.map((b)=>{
                  const cellBg=bucketCellBg(b);
                  if(tab==="count"){const v=gtCountVal(b);return<td key={b} className={`px-3 py-2.5 text-right ${cellBg} bg-slate-100 min-w-[120px]`}><span className="inline-flex items-center justify-center bg-slate-200 text-slate-800 rounded-full px-2.5 py-0.5 text-xs font-bold">{v.toLocaleString()}</span></td>;}
                  if(tab==="target"){const v=gtTargetVal(b);return<td key={b} className={`px-3 py-2.5 text-right ${cellBg} bg-slate-100 min-w-[120px]`}>{renderMoney(v,"text-indigo-900")}</td>;}
                  if(tab==="paid"){
                    if(isBadDebtExpanded(b)){const installRaw=gtPaidBadDebtInstallRaw(b);const installVisible=gtPaidBadDebtInstallVisible(b);const saleRaw=gtPaidBadDebtRaw(b);const sale=showBadDebtSale?saleRaw:0;const total=installVisible+sale;return(<React.Fragment key={b}><td className={`px-3 py-2.5 text-right ${cellBg} bg-slate-100 min-w-[120px]`}>{installVisible===0?<span className="text-gray-300">{fmtMoney(installRaw)}</span>:renderMoney(installVisible,"text-green-900")}</td><td className={`px-3 py-2.5 text-right ${cellBg} bg-slate-100 min-w-[120px]`}>{!showBadDebtSale?<span className="text-gray-300">{fmtMoney(saleRaw)}</span>:renderMoney(sale,"text-red-700")}</td><td className={`px-3 py-2.5 text-right font-bold ${cellBg} bg-slate-100 min-w-[120px]`}>{renderMoney(total,"text-gray-900")}</td></React.Fragment>);}
                    const v=gtPaidVal(b);return<td key={b} className={`px-3 py-2.5 text-right ${cellBg} bg-slate-100 min-w-[120px]`}>{renderMoney(v,"text-green-900")}</td>;
                  }
                  if(tab==="due"){
                    if(isBadDebtExpanded(b)){const installRaw=gtDueBadDebtInstallRaw(b);const install=paidVis.badDebtInstallment?installRaw:0;return(<React.Fragment key={b}><td className={`px-3 py-2.5 text-right ${cellBg} bg-slate-100 min-w-[120px]`}>{!paidVis.badDebtInstallment?<span className="text-gray-300">{fmtMoney(installRaw)}</span>:renderMoney(install,"text-orange-900")}</td><td className={`px-3 py-2.5 text-right ${cellBg} bg-slate-100 min-w-[120px]`}><span className="text-gray-300">0.00</span></td><td className={`px-3 py-2.5 text-right font-bold ${cellBg} bg-slate-100 min-w-[120px]`}>{renderMoney(install,"text-gray-900")}</td></React.Fragment>);}
                    const v=gtDueVal(b);return<td key={b} className={`px-3 py-2.5 text-right ${cellBg} bg-slate-100 min-w-[120px]`}>{renderMoney(v,"text-orange-900")}</td>;
                  }
                  if(tab==="installTotal"){return<td key={b} className={`px-3 py-2.5 text-right ${cellBg} bg-slate-100 min-w-[120px]`}>{renderMoney(gtInstallVal(b),"text-purple-900")}</td>;}
                  // notYetDue
                  const v=gtNotYetDueVal(b);return<td key={b} className={`px-3 py-2.5 text-right ${cellBg} bg-slate-100 min-w-[120px]`}>{renderMoney(v,"text-blue-900")}</td>;
                })}
                {g.hasSubtotal&&(()=>{
                  const subBg=gi===0?"bg-green-100":"bg-orange-100";
                  const buckets=gi===0?normalBuckets:suspectBuckets;
                  if(tab==="count"){const v=gi===0?gtNormalCount:gtSuspectCount;return<td className={`px-3 py-2.5 text-right font-bold ${subBg} border-r border-slate-300 min-w-[120px]`}><span className="inline-flex items-center justify-center bg-slate-300 text-slate-800 rounded-full px-2.5 py-0.5 text-xs font-bold">{v.toLocaleString()}</span></td>;}
                  if(tab==="installTotal"){const v=buckets.reduce((s,b)=>s+gtInstallVal(b),0);return<td className={`px-3 py-2.5 text-right font-bold ${subBg} border-r border-slate-300 min-w-[120px]`}>{renderMoney(v,"text-purple-900")}</td>;}
                  if(tab==="target"){const v=gi===0?gtNormalTarget:gtSuspectTarget;return<td className={`px-3 py-2.5 text-right font-bold ${subBg} border-r border-slate-300 min-w-[120px]`}>{renderMoney(v,"text-indigo-900")}</td>;}
                  if(tab==="paid"){const v=gi===0?gtNormalPaid:gtSuspectPaid;return<td className={`px-3 py-2.5 text-right font-bold ${subBg} border-r border-slate-300 min-w-[120px]`}>{renderMoney(v,"text-green-900")}</td>;}
                  if(tab==="due"){const v=gi===0?gtNormalDue:gtSuspectDue;return<td className={`px-3 py-2.5 text-right font-bold ${subBg} border-r border-slate-300 min-w-[120px]`}>{renderMoney(v,"text-orange-900")}</td>;}
                  const v=gi===0?gtNormalNotYetDue:gtSuspectNotYetDue;return<td className={`px-3 py-2.5 text-right font-bold ${subBg} border-r border-slate-300 min-w-[120px]`}>{renderMoney(v,"text-blue-900")}</td>;
                })()}
              </React.Fragment>
            ))}

          </tr>
      </tfoot>
    </table>
    </>
  );
}

// ─── CombinedBadgePanel ─────────────────────────────────────────────────────────
// Badge Panel สำหรับ tab สรุปรวม — render นอก scroll container เพื่อไม่ให้เลื่อนตามตาราง
function CombinedBadgePanel({
  grandTotal,hiddenBuckets,
  paidVis,setPaidVis,targetVis,setTargetVis,
  dueVis,setDueVis,notYetDueVis,setNotYetDueVis,
  installVis,setInstallVis,
  showBadDebtSale,setShowBadDebtSale,
}:{
  grandTotal:GrandTotal;hiddenBuckets:Set<string>;
  paidVis:Record<MoneyBadgeKey,boolean>;setPaidVis:React.Dispatch<React.SetStateAction<Record<MoneyBadgeKey,boolean>>>;
  targetVis:Record<MoneyBadgeKey,boolean>;setTargetVis:React.Dispatch<React.SetStateAction<Record<MoneyBadgeKey,boolean>>>;
  dueVis:Record<DueBadgeKey,boolean>;setDueVis:React.Dispatch<React.SetStateAction<Record<DueBadgeKey,boolean>>>;
  notYetDueVis:Record<NotYetDueBadgeKey,boolean>;setNotYetDueVis:React.Dispatch<React.SetStateAction<Record<NotYetDueBadgeKey,boolean>>>;
  installVis:Record<"principal"|"interest"|"fee",boolean>;setInstallVis:React.Dispatch<React.SetStateAction<Record<"principal"|"interest"|"fee",boolean>>>;
  showBadDebtSale:boolean;setShowBadDebtSale:(v:boolean)=>void;
}){
  const [expandedBadges,setExpandedBadges]=React.useState<Set<TabKey>>(new Set());
  function toggleBadge(k:TabKey){setExpandedBadges((p)=>{const n=new Set(p);if(n.has(k))n.delete(k);else n.add(k);return n;});}
  function toggleInstallVis(k:"principal"|"interest"|"fee"){setInstallVis((p)=>({...p,[k]:!p[k]}));}
  function togglePaidVis(k:MoneyBadgeKey){setPaidVis((p)=>({...p,[k]:!p[k]}));}
  function toggleTargetVis(k:MoneyBadgeKey){setTargetVis((p)=>({...p,[k]:!p[k]}));}
  function toggleDueVis(k:DueBadgeKey){setDueVis((p)=>({...p,[k]:!p[k]}));}
  function toggleNotYetDueVis(k:NotYetDueBadgeKey){setNotYetDueVis((p)=>({...p,[k]:!p[k]}));}

  // คำนวณ grand total badge values
  const gtBadgeInstall=React.useMemo(()=>{let r=emptyMoney();for(const b of DEBT_BUCKETS){if(hiddenBuckets.has(b))continue;const bt=grandTotal.bucketTotals[b];if(bt)r=addMoney(r,bt.installTotal);}return r;},[grandTotal,hiddenBuckets]);
  const gtBadgeTarget=React.useMemo(()=>{let r=emptyMoney();for(const b of DEBT_BUCKETS){if(hiddenBuckets.has(b))continue;const bt=grandTotal.bucketTotals[b];if(bt)r=addMoney(r,bt.target);}return r;},[grandTotal,hiddenBuckets]);
  const gtBadgePaid=React.useMemo(()=>{let r=emptyMoney();for(const b of DEBT_BUCKETS){if(hiddenBuckets.has(b))continue;const bt=grandTotal.bucketTotals[b];if(bt)r=addMoney(r,bt.paid);}return r;},[grandTotal,hiddenBuckets]);
  const gtBadgeDue=React.useMemo(()=>{let r=emptyMoney();for(const b of DEBT_BUCKETS){if(hiddenBuckets.has(b))continue;const bt=grandTotal.bucketTotals[b];if(bt)r=addMoney(r,bt.due);}return r;},[grandTotal,hiddenBuckets]);
  const gtBadgeNotYetDue=React.useMemo(()=>{let r=emptyMoney();for(const b of DEBT_BUCKETS){if(hiddenBuckets.has(b))continue;const bt=grandTotal.bucketTotals[b];if(bt)r=addMoney(r,bt.notYetDue);}return r;},[grandTotal,hiddenBuckets]);

  function BadgeItemRow({isOn,onToggle,label,val,color}:{isOn:boolean;onToggle:()=>void;label:string;val:number;color:string}){
    return(
      <button type="button" onClick={onToggle}
        className={["flex items-center gap-1 px-2 py-1 rounded text-xs border transition-colors",color,isOn?"opacity-100":"opacity-40 line-through"].join(" ")}>
        {isOn?<Eye className="w-3 h-3"/>:<EyeOff className="w-3 h-3"/>}
        {label} {fmtMoney(val)}
      </button>
    );
  }

  const BADGE_DEFS=[
    {key:"count" as TabKey,       label:"สัญญา",          color:"bg-slate-100 border-slate-300 text-slate-700"},
    {key:"installTotal" as TabKey, label:"ยอดผ่อนรวม",    color:"bg-purple-100 border-purple-300 text-purple-700"},
    {key:"target" as TabKey,      label:"เป้าเก็บหนี้",   color:"bg-indigo-100 border-indigo-300 text-indigo-700"},
    {key:"paid" as TabKey,        label:"ยอดเก็บหนี้",    color:"bg-green-100 border-green-300 text-green-700"},
    {key:"due" as TabKey,         label:"หนี้ค้างชำระ",   color:"bg-orange-100 border-orange-300 text-orange-700"},
    {key:"notYetDue" as TabKey,   label:"ยังไม่ถึงกำหนด", color:"bg-blue-100 border-blue-300 text-blue-700"},
  ];

  return(
    <div className="flex-shrink-0 bg-teal-50/60 border-b border-teal-200 px-4 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-teal-700 whitespace-nowrap">Badge แต่ละแถบ:</span>
        {BADGE_DEFS.map(({key,label,color})=>(
          <button key={key} type="button" onClick={()=>toggleBadge(key)}
            className={["flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border font-medium transition-colors",color,expandedBadges.has(key)?"ring-2 ring-offset-1 ring-teal-400":"opacity-70 hover:opacity-100"].join(" ")}>
            {expandedBadges.has(key)?<Eye className="w-3 h-3"/>:<EyeOff className="w-3 h-3"/>}
            {label}
          </button>
        ))}
      </div>
      {expandedBadges.size>0&&(
        <div className="mt-2 flex flex-col gap-1.5">
          {expandedBadges.has("count")&&(
            <div className="flex flex-wrap items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-50 border border-slate-200">
              <span className="text-[11px] font-semibold text-slate-600 whitespace-nowrap mr-1">สัญญา:</span>
              <span className="flex items-center gap-1.5 px-2 py-1 rounded text-xs bg-slate-100 border border-slate-300 text-slate-700 font-semibold">
                <Banknote className="w-3 h-3"/>รวม {grandTotal.totalCount.toLocaleString()} สัญญา
              </span>
            </div>
          )}
          {expandedBadges.has("installTotal")&&(
            <div className="flex flex-wrap items-center gap-2 px-3 py-1.5 rounded-lg bg-purple-50/60 border border-purple-200">
              <span className="text-[11px] font-semibold text-purple-700 whitespace-nowrap mr-1">ยอดผ่อนรวม:</span>
              {(["principal","interest","fee"] as const).map((k)=>{
                const labels={principal:"เงินต้น",interest:"ดอกเบี้ย",fee:"ค่าดำเนินการ"};
                return(<BadgeItemRow key={k} isOn={installVis[k]} onToggle={()=>toggleInstallVis(k)} label={labels[k]} val={gtBadgeInstall[k]} color="bg-purple-100 border-purple-300 text-purple-800"/>);
              })}
              <span className="flex items-center gap-1.5 px-2 py-1 rounded text-xs bg-purple-700 border border-purple-800 text-white font-semibold">
                <Banknote className="w-3 h-3"/>รวม {fmtMoney((installVis.principal?gtBadgeInstall.principal:0)+(installVis.interest?gtBadgeInstall.interest:0)+(installVis.fee?gtBadgeInstall.fee:0))}
              </span>
            </div>
          )}
          {expandedBadges.has("target")&&(
            <div className="flex flex-wrap items-center gap-2 px-3 py-1.5 rounded-lg bg-indigo-50/60 border border-indigo-200">
              <span className="text-[11px] font-semibold text-indigo-700 whitespace-nowrap mr-1">เป้าเก็บหนี้:</span>
              {MONEY_BADGE_ITEMS.filter(x=>x.key!=="discount"&&x.key!=="overpaid").map(({key:k,label})=>{
                const val=gtBadgeTarget[k as keyof MoneyBreakdown] as number;
                return(<BadgeItemRow key={k} isOn={targetVis[k as MoneyBadgeKey]} onToggle={()=>toggleTargetVis(k as MoneyBadgeKey)} label={label} val={val} color="bg-indigo-100 border-indigo-300 text-indigo-800"/>);
              })}
              <span className="flex items-center gap-1.5 px-2 py-1 rounded text-xs bg-indigo-700 border border-indigo-800 text-white font-semibold">
                <Banknote className="w-3 h-3"/>รวม {fmtMoney(computeMoneyTotal(gtBadgeTarget,{...targetVis,discount:false,overpaid:false}))}
              </span>
            </div>
          )}
          {expandedBadges.has("paid")&&(
            <div className="flex flex-wrap items-center gap-2 px-3 py-1.5 rounded-lg bg-green-50/60 border border-green-200">
              <span className="text-[11px] font-semibold text-green-700 whitespace-nowrap mr-1">ยอดเก็บหนี้:</span>
              {MONEY_BADGE_ITEMS.map(({key:k,label,canToggle})=>{
                const val=gtBadgePaid[k as keyof MoneyBreakdown] as number;
                return(<BadgeItemRow key={k} isOn={paidVis[k as MoneyBadgeKey]} onToggle={()=>canToggle&&togglePaidVis(k as MoneyBadgeKey)} label={label} val={val} color="bg-green-100 border-green-300 text-green-800"/>);
              })}
              <button type="button" onClick={()=>setShowBadDebtSale(!showBadDebtSale)}
                className={["flex items-center gap-1 px-2 py-1 rounded text-xs border transition-colors bg-green-100 border-green-300 text-green-800",showBadDebtSale?"opacity-100":"opacity-40 line-through"].join(" ")}>
                {showBadDebtSale?<Eye className="w-3 h-3"/>:<EyeOff className="w-3 h-3"/>}หนี้เสีย(ขายเครื่อง) {fmtMoney(gtBadgePaid.badDebt??0)}
              </button>
              <span className="flex items-center gap-1.5 px-2 py-1 rounded text-xs bg-green-700 border border-green-800 text-white font-semibold">
                <Banknote className="w-3 h-3"/>รวม {fmtMoney(computeMoneyTotal(gtBadgePaid,paidVis)+(showBadDebtSale?(gtBadgePaid.badDebt??0):0))}
              </span>
            </div>
          )}
          {expandedBadges.has("due")&&(
            <div className="flex flex-wrap items-center gap-2 px-3 py-1.5 rounded-lg bg-orange-50/60 border border-orange-200">
              <span className="text-[11px] font-semibold text-orange-700 whitespace-nowrap mr-1">หนี้ค้างชำระ:</span>
              {DUE_BADGE_ITEMS.map(({key:k,label})=>{
                const val=gtBadgeDue[k as keyof MoneyBreakdown] as number;
                return(<BadgeItemRow key={k} isOn={dueVis[k as DueBadgeKey]} onToggle={()=>toggleDueVis(k as DueBadgeKey)} label={label} val={val} color="bg-orange-100 border-orange-300 text-orange-800"/>);
              })}
              <span className="flex items-center gap-1.5 px-2 py-1 rounded text-xs bg-orange-700 border border-orange-800 text-white font-semibold">
                <Banknote className="w-3 h-3"/>รวม {fmtMoney(computeDueTotal(gtBadgeDue,dueVis))}
              </span>
            </div>
          )}
          {expandedBadges.has("notYetDue")&&(
            <div className="flex flex-wrap items-center gap-2 px-3 py-1.5 rounded-lg bg-blue-50/60 border border-blue-200">
              <span className="text-[11px] font-semibold text-blue-700 whitespace-nowrap mr-1">ยังไม่ถึงกำหนด:</span>
              {NOT_YET_DUE_BADGE_ITEMS.map(({key:k,label})=>{
                const val=gtBadgeNotYetDue[k as keyof MoneyBreakdown] as number;
                return(<BadgeItemRow key={k} isOn={notYetDueVis[k as NotYetDueBadgeKey]} onToggle={()=>toggleNotYetDueVis(k as NotYetDueBadgeKey)} label={label} val={val} color="bg-blue-100 border-blue-300 text-blue-800"/>);
              })}
              <span className="flex items-center gap-1.5 px-2 py-1 rounded text-xs bg-blue-700 border border-blue-800 text-white font-semibold">
                <Banknote className="w-3 h-3"/>รวม {fmtMoney(computeNotYetDueTotal(gtBadgeNotYetDue,notYetDueVis))}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── CombinedTable ────────────────────────────────────────────────────────────
// แสดงข้อมูลทุกแถบในตารางเดียว แต่ละเดือนมี 6 sub-row
const COMBINED_SUB_ROWS: Array<{
  key: TabKey;
  label: string;
  rowBg: string;
  textColor: string;
  totalBg: string;
}> = [
  {key:"count",        label:"สัญญา",          rowBg:"bg-slate-50",   textColor:"text-slate-700",   totalBg:"bg-slate-100"},
  {key:"installTotal", label:"ยอดผ่อนรวม",     rowBg:"bg-purple-50",  textColor:"text-purple-800",  totalBg:"bg-purple-100"},
  {key:"target",       label:"เป้าเก็บหนี้",   rowBg:"bg-indigo-50",  textColor:"text-indigo-800",  totalBg:"bg-indigo-100"},
  {key:"paid",         label:"ยอดเก็บหนี้",    rowBg:"bg-green-50",   textColor:"text-green-800",   totalBg:"bg-green-100"},
  {key:"due",          label:"หนี้ค้างชำระ",   rowBg:"bg-orange-50",  textColor:"text-orange-800",  totalBg:"bg-orange-100"},
  {key:"notYetDue",    label:"ยังไม่ถึงกำหนด", rowBg:"bg-blue-50",    textColor:"text-blue-800",    totalBg:"bg-blue-100"},
];

// กลุ่มหัวตาราง 2 ชั้น
const BUCKET_GROUPS = [
  {label:"ปกติ",         bg:"bg-green-700",   buckets:["ปกติ","เกิน 1-7","เกิน 8-14","เกิน 15-30","เกิน 31-60"], hasSubtotal:true,  subtotalBg:"bg-green-100"},
  {label:"สงสัยจะเสีย", bg:"bg-orange-600",  buckets:["เกิน 61-90","เกิน >90"],                                   hasSubtotal:true,  subtotalBg:"bg-orange-100"},
  {label:"ระงับสัญญา",  bg:"bg-red-700",     buckets:["ระงับสัญญา"],                                              hasSubtotal:false, subtotalBg:""},
  {label:"สิ้นสุดสัญญา",bg:"bg-gray-600",    buckets:["สิ้นสุดสัญญา"],                                            hasSubtotal:false, subtotalBg:""},
  {label:"หนี้เสีย",    bg:"bg-gray-900",    buckets:["หนี้เสีย"],                                                hasSubtotal:false, subtotalBg:""},
];

function CombinedTable({
  rows,grandTotal,hiddenBuckets,toggleBucket,
  sortDir,onToggleSort,hiddenRows,toggleRow,hiddenSubRows,
  paidVis,setPaidVis,targetVis,setTargetVis,
  dueVis,setDueVis,notYetDueVis,setNotYetDueVis,
  installVis,setInstallVis,
  showBadDebtInstall,setShowBadDebtInstall,
  showBadDebtSale,setShowBadDebtSale,
  stickyTop,
}:{
  rows:SummaryRow[];grandTotal:GrandTotal;hiddenBuckets:Set<string>;
  toggleBucket:(b:string)=>void;
  sortDir:SortDir;onToggleSort:()=>void;
  hiddenRows:Set<string>;toggleRow:(month:string)=>void;
  hiddenSubRows:Set<TabKey>;
  paidVis:Record<MoneyBadgeKey,boolean>;setPaidVis:React.Dispatch<React.SetStateAction<Record<MoneyBadgeKey,boolean>>>;
  targetVis:Record<MoneyBadgeKey,boolean>;setTargetVis:React.Dispatch<React.SetStateAction<Record<MoneyBadgeKey,boolean>>>;
  dueVis:Record<DueBadgeKey,boolean>;setDueVis:React.Dispatch<React.SetStateAction<Record<DueBadgeKey,boolean>>>;
  notYetDueVis:Record<NotYetDueBadgeKey,boolean>;setNotYetDueVis:React.Dispatch<React.SetStateAction<Record<NotYetDueBadgeKey,boolean>>>;
  installVis:Record<"principal"|"interest"|"fee",boolean>;setInstallVis:React.Dispatch<React.SetStateAction<Record<"principal"|"interest"|"fee",boolean>>>;
  showBadDebtInstall:boolean;setShowBadDebtInstall:(v:boolean)=>void;
  showBadDebtSale:boolean;setShowBadDebtSale:(v:boolean)=>void;
  stickyTop:number;
}) {
  const ArrowUp2=ArrowUp;const ArrowDown2=ArrowDown;
  const SortIconCombined=sortDir==="asc"?ArrowUp2:ArrowDown2;

  // ── คำนวณ cell value ตาม vis state ──────────────────────────────────────
  function cellValue(subKey:TabKey, cell:SummaryCell|undefined):number {
    if(!cell)return 0;
    if(subKey==="count")return cell.contractCount;
    if(subKey==="installTotal"){
      return (installVis.principal?cell.installTotal.principal:0)
           + (installVis.interest?cell.installTotal.interest:0)
           + (installVis.fee?cell.installTotal.fee:0);
    }
    if(subKey==="target")return computeMoneyTotal(cell.target,{...targetVis,discount:false,overpaid:false});
    if(subKey==="paid")return computeMoneyTotal(cell.paid,paidVis);
    if(subKey==="due")return computeDueTotal(cell.due,dueVis);
    return computeNotYetDueTotal(cell.notYetDue,notYetDueVis);
  }
  // paid sub-columns สำหรับ bucket หนี้เสีย
  function cellPaidInstall(cell:SummaryCell|undefined):number {
    if(!cell)return 0;
    // คอลัมน์ค่างวด: ใช้ computeMoneyTotal เพื่อให้ badge toggle มีผล (หักตาม badge ที่ปิดตา)
    return computeMoneyTotal(cell.paid, paidVis);
  }
  function cellPaidInstallRaw(cell:SummaryCell|undefined):number {
    if(!cell)return 0;
    // ยอดดิบสำหรับแสดงตอน dimmed
    return cell.paid.badDebtInstallment??0;
  }
  function cellPaidSale(cell:SummaryCell|undefined):number {
    if(!cell)return 0;
    return showBadDebtSale?(cell.paid.badDebt??0):0;
  }

  function rowTotal(subKey:TabKey, row:SummaryRow):number {
    return DEBT_BUCKETS.reduce((s,b)=>{
      if(hiddenBuckets.has(b))return s;
      const cell=row.buckets[b];
      if(subKey==="paid"&&b==="หนี้เสีย"){
        return s+computeMoneyTotal(cell?.paid??emptyMoney(),paidVis)+(showBadDebtSale?(cell?.paid.badDebt??0):0);
      }
      return s+cellValue(subKey,cell);
    },0);
  }
  function gtValue(subKey:TabKey, bucket:string):number {
    const bt=grandTotal.bucketTotals[bucket];if(!bt)return 0;
    if(subKey==="count")return bt.count;
    if(subKey==="installTotal")return (installVis.principal?bt.installTotal.principal:0)+(installVis.interest?bt.installTotal.interest:0)+(installVis.fee?bt.installTotal.fee:0);
    if(subKey==="target")return computeMoneyTotal(bt.target,{...targetVis,discount:false,overpaid:false});
    if(subKey==="paid")return computeMoneyTotal(bt.paid,paidVis);
    if(subKey==="due")return computeDueTotal(bt.due,dueVis);
    return computeNotYetDueTotal(bt.notYetDue,notYetDueVis);
  }
  // grand total คอลัมน์ค่างวดหนี้เสีย (visible ตาม badge)
  function gtPaidInstall(bucket:string):number {
    const bt=grandTotal.bucketTotals[bucket];if(!bt)return 0;
    return computeMoneyTotal(bt.paid,paidVis);
  }
  function gtPaidInstallRaw(bucket:string):number {
    const bt=grandTotal.bucketTotals[bucket];if(!bt)return 0;
    return bt.paid.badDebtInstallment??0;
  }
  function gtRowTotal(subKey:TabKey):number {
    return DEBT_BUCKETS.reduce((s,b)=>{
      if(hiddenBuckets.has(b))return s;
      if(subKey==="paid"&&b==="หนี้เสีย"){
        const bt=grandTotal.bucketTotals[b];
        return s+computeMoneyTotal(bt?.paid??emptyMoney(),paidVis)+(showBadDebtSale?(bt?.paid.badDebt??0):0);
      }
      return s+gtValue(subKey,b);
    },0);
  }

  // ── % tag helpers ────────────────────────────────────────────────────────────────────
  function fmtPct(num:number, den:number):string|null {
    if(den===0||num===0)return null;
    const p=(num/den)*100;
    return p.toFixed(1)+"%";
  }
  function PctTag({pct,color,tooltip}:{pct:string|null;color:string;tooltip:string}):React.ReactElement|null {
    if(!pct)return null;
    return(
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={["inline-flex items-center ml-1 px-1.5 py-0.5 rounded text-[10px] font-semibold border cursor-help select-none",color].join(" ")}>{pct}</span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[200px] text-center text-xs">{tooltip}</TooltipContent>
      </Tooltip>
    );
  }

  // ── render helpers ────────────────────────────────────────────────────────────────────
  function renderCellVal(subKey:TabKey, val:number, textColor:string):React.ReactNode {
    if(val===0)return <span className="text-gray-300 text-xs">—</span>;
    if(subKey==="count"){
      return<span className="inline-flex items-center justify-center bg-slate-100 text-slate-700 rounded-full px-2.5 py-0.5 text-xs font-bold">{val.toLocaleString()}</span>;
    }
    return<span className={["text-xs font-medium",textColor].join(" ")}>{fmtMoney(val)}</span>;
  }
  function renderMoney(val:number, textColor:string):React.ReactNode {
    if(val===0)return <span className="text-gray-300 text-xs">—</span>;
    return<span className={["text-xs font-medium",textColor].join(" ")}>{fmtMoney(val)}</span>;
  }

  const minWidth=130+90+90+(DEBT_BUCKETS.length*110)+90+(2*110); // +90 bad-debt sub-cols, +2*110 subtotal cols for ปกติ/สงสัยจะเสีย

  return(
    <>
    {/* ── Table ──────────────────────────────────────────────────────────────────── */}
    <table className="w-full text-xs border-collapse" style={{minWidth:`${minWidth}px`}}>
      <thead className="sticky z-20" style={{top:`${stickyTop}px`}}>
        {/* ── Row 1: group headers ────────────────────────────────────── */}
        <tr>
          <th rowSpan={2} className="sticky left-0 z-30 px-3 py-2 text-left font-semibold whitespace-nowrap bg-teal-800 text-white border-r border-teal-600 min-w-[130px]">
            <button type="button" onClick={onToggleSort} className="flex items-center gap-1 hover:opacity-80 transition-opacity" title={sortDir==="asc"?"เรียงใหม่→เก่า":"เรียงเก่า→ใหม่"}>
              เดือน-ปีที่อนุมัติ<SortIconCombined className="w-3.5 h-3.5 text-teal-300"/>
            </button>
          </th>
          <th rowSpan={2} className="sticky left-[130px] z-30 px-3 py-2 text-center font-semibold whitespace-nowrap bg-teal-700 text-white border-r border-teal-500 min-w-[90px]">
            หัวข้อ
          </th>
          <th rowSpan={2} className="sticky left-[220px] z-30 px-3 py-2 text-right font-semibold whitespace-nowrap bg-teal-700 text-white border-r border-teal-500 min-w-[90px]">
            รวม
          </th>
          {/* group headers */}
          {BUCKET_GROUPS.map((g)=>{
            // นับ colspan = จำนวน bucket ในกลุ่ม + subtotal col + (กลุ่มหนี้เสียมี 3 sub-col แทน 1 bucket)
            const colCount = g.label==="หนี้เสีย" ? 3 : g.buckets.length + (g.hasSubtotal ? 1 : 0);
            // ตรวจสอบว่า bucket ในกลุ่มนี้ถูกซ่อนทั้งหมดหรือไม่
            const allHidden=g.buckets.every(b=>hiddenBuckets.has(b));
            return(
              <th key={g.label} colSpan={colCount}
                className={["px-2 py-1.5 text-center font-semibold text-white whitespace-nowrap border-r border-white/30",g.bg,allHidden?"opacity-50":""].join(" ")}>
                <div className="flex items-center justify-center gap-1">
                  <button type="button" onClick={()=>g.buckets.forEach(b=>toggleBucket(b))} title="เปิด/ปิดทั้งกลุ่ม" className="hover:opacity-70 transition-opacity">
                    {allHidden?<EyeOff className="w-3 h-3"/>:<Eye className="w-3 h-3"/>}
                  </button>
                  <span className="text-[11px]">{g.label}</span>
                </div>
              </th>
            );
          })}
        </tr>
        {/* ── Row 2: bucket sub-headers ───────────────────────────────── */}
        <tr>
          {BUCKET_GROUPS.map((g)=>
            g.buckets.map((b,bi)=>{
              const isLast=bi===g.buckets.length-1;
              const isBadDebtBucket=g.label==="หนี้เสีย";
              return(
                <React.Fragment key={b}>
                  {/* สำหรับ bucket หนี้เสีย: แสดงเป็น 3 sub-col (ค่างวด/ขายเครื่อง/รวม) แทน bucket หลัก */}
                  {isBadDebtBucket?(
                    <>
                      <th className={["px-2 py-1.5 text-center font-semibold text-white whitespace-nowrap min-w-[90px] border-r border-white/20",g.bg].join(" ")}>
                        <div className="flex flex-col items-center gap-0.5">
                          <button type="button" onClick={()=>{const PAID_KEYS=["principal","interest","fee","penalty","unlockFee","discount","overpaid"] as const;const anyOn=PAID_KEYS.some(k=>paidVis[k]);setPaidVis(prev=>({...prev,...Object.fromEntries(PAID_KEYS.map(k=>[k,!anyOn]))}));}} className="hover:opacity-70">
                            {(["principal","interest","fee","penalty","unlockFee","discount","overpaid"] as const).some(k=>paidVis[k])?<Eye className="w-3 h-3"/>:<EyeOff className="w-3 h-3"/>}
                          </button>
                          <span className="text-[10px]">ค่างวด</span>
                        </div>
                      </th>
                      <th className={["px-2 py-1.5 text-center font-semibold text-white whitespace-nowrap min-w-[90px] border-r border-white/20",g.bg].join(" ")}>
                        <div className="flex flex-col items-center gap-0.5">
                          <button type="button" onClick={()=>setShowBadDebtSale(!showBadDebtSale)} className="hover:opacity-70">
                            {showBadDebtSale?<Eye className="w-3 h-3"/>:<EyeOff className="w-3 h-3"/>}
                          </button>
                          <span className="text-[10px]">ขายเครื่อง</span>
                        </div>
                      </th>
                      <th className={["px-2 py-1.5 text-center font-semibold text-white whitespace-nowrap min-w-[90px] border-r border-white/20",g.bg].join(" ")}>
                        <div className="flex flex-col items-center gap-0.5">
                          <Eye className="w-3 h-3 opacity-60"/>
                          <span className="text-[10px]">รวม</span>
                        </div>
                      </th>
                    </>
                  ):(
                    <>
                      <th
                        onClick={()=>toggleBucket(b)}
                        className={["px-2 py-1.5 text-center font-semibold text-white whitespace-nowrap min-w-[110px] border-r border-white/20 cursor-pointer hover:opacity-80 transition-opacity",g.bg,hiddenBuckets.has(b)?"opacity-40":""].join(" ")}>
                        <div className="flex flex-col items-center gap-0.5">
                          {hiddenBuckets.has(b)?<EyeOff className="w-3 h-3"/>:<Eye className="w-3 h-3"/>}
                          <span className={["inline-block px-1.5 py-0.5 rounded-full text-[10px] border",bucketPillClasses(b)].join(" ")}>{b}</span>
                        </div>
                      </th>
                      {/* subtotal col หลัง bucket สุดท้ายของกลุ่ม ปกติ/สงสัยจะเสีย */}
                      {isLast&&g.hasSubtotal&&(
                        <th className={["px-2 py-1.5 text-center font-bold text-white whitespace-nowrap min-w-[110px] border-r border-white/30",g.bg].join(" ")}>
                          <span className="text-[10px]">รวม</span>
                        </th>
                      )}
                    </>
                  )}
                </React.Fragment>
              );
            })
          )}
        </tr>
      </thead>
      <tbody>
        {rows.map((row)=>{
          const isHiddenRow=hiddenRows.has(row.approveMonth);
          return(
            <React.Fragment key={row.approveMonth}>
              {COMBINED_SUB_ROWS.filter(sr=>sr.key==="count"||!hiddenSubRows.has(sr.key)).map((sr,srIdx,visArr)=>(
                <tr key={sr.key} className={["border-b border-gray-100 transition-colors",srIdx===0?"border-t-2 border-t-gray-300":"",isHiddenRow?"opacity-40":"",sr.rowBg].join(" ")}>
                  {/* เดือน — rowSpan=6 */}
                  {srIdx===0&&(
                    <td rowSpan={visArr.length} className="sticky left-0 z-10 px-3 py-2 text-sm font-semibold whitespace-nowrap bg-white border-r border-gray-200 min-w-[130px] align-middle">
                      <div className="flex items-center gap-1.5">
                        <button type="button" onClick={()=>toggleRow(row.approveMonth)} title={isHiddenRow?"แสดงแถวนี้":"ซ่อนแถวนี้"} className="hover:opacity-70 transition-opacity">
                          {isHiddenRow?<EyeOff className="w-3.5 h-3.5 text-gray-400"/>:<Eye className="w-3.5 h-3.5 text-gray-400"/>}
                        </button>
                        <span className="text-gray-800">{fmtMonthYear(row.approveMonth)}</span>
                      </div>
                    </td>
                  )}
                  {/* ชื่อหัวข้อ */}
                  <td className={["sticky left-[130px] z-10 px-2 py-1.5 text-center whitespace-nowrap border-r border-gray-200 font-medium text-[11px] min-w-[90px]",sr.totalBg,sr.textColor].join(" ")}>
                    {sr.label}
                  </td>
                  {/* รวม */}
                  <td className={["sticky left-[220px] z-10 px-3 py-1.5 text-right border-r border-gray-200 min-w-[200px]",sr.totalBg].join(" ")}>
                    {(()=>{
                      const val=isHiddenRow?0:rowTotal(sr.key,row);
                      const installVal=isHiddenRow?0:rowTotal("installTotal",row);
                      const targetVal=isHiddenRow?0:rowTotal("target",row);
                      // หักยอดขายเครื่อง (badDebt) ออกก่อนคำนวณ % ยอดเก็บหนี้
                      const paidSaleAmt=isHiddenRow?0:DEBT_BUCKETS.reduce((s,b)=>{
                        if(hiddenBuckets.has(b))return s;
                        const cell=row.buckets[b];
                        return s+(showBadDebtSale?(cell?.paid.badDebt??0):0);
                      },0);
                      const paidNetVal=val-paidSaleAmt;
                      return(
                        <span className="inline-flex items-center justify-end flex-nowrap gap-0.5 whitespace-nowrap">
                          {renderCellVal(sr.key,val,sr.textColor)}
                          {sr.key==="target"&&<PctTag pct={fmtPct(val,installVal)} color="bg-indigo-50 border-indigo-300 text-indigo-700" tooltip={`เป้าเก็บหนี้ ${fmtPct(val,installVal)??""} ของยอดผ่อนรวม`}/>}
                          {sr.key==="paid"&&<>{!hiddenSubRows.has("installTotal")&&<PctTag pct={fmtPct(paidNetVal,installVal)} color="bg-purple-50 border-purple-300 text-purple-700" tooltip={`ยอดเก็บหนี้ (หักขายเครื่อง) ${fmtPct(paidNetVal,installVal)??""} ของยอดผ่อนรวม`}/>}{!hiddenSubRows.has("target")&&<PctTag pct={fmtPct(paidNetVal,targetVal)} color="bg-indigo-50 border-indigo-300 text-indigo-700" tooltip={`ยอดเก็บหนี้ (หักขายเครื่อง) ${fmtPct(paidNetVal,targetVal)??""} ของเป้าเก็บหนี้`}/>}</> }
                          {sr.key==="due"&&<PctTag pct={fmtPct(val,targetVal)} color="bg-orange-50 border-orange-300 text-orange-700" tooltip={`หนี้ค้างชำระ ${fmtPct(val,targetVal)??""} ของเป้าเก็บหนี้`}/>}
                          {sr.key==="notYetDue"&&<PctTag pct={fmtPct(val,installVal)} color="bg-blue-50 border-blue-300 text-blue-700" tooltip={`ยังไม่ถึงกำหนด ${fmtPct(val,installVal)??""} ของยอดผ่อนรวม`}/>}
                        </span>
                      );
                    })()}
                  </td>
                  {/* bucket cells */}
                  {BUCKET_GROUPS.map((g)=>
                    g.buckets.map((b,bi)=>{
                      const cell=row.buckets[b];
                      const isBucketHidden=hiddenBuckets.has(b);
                      const isDimmed=isHiddenRow||isBucketHidden;
                      const val=isDimmed?0:cellValue(sr.key,cell);
                      const cellBg=bucketCellBg(b);
                      const isLast=bi===g.buckets.length-1;
                      const isBadDebtBucket=g.label==="หนี้เสีย";
                      return(
                        <React.Fragment key={b}>
                          {/* bucket หนี้เสีย: แสดงเป็น 3 sub-col (ค่างวด/ขายเครื่อง/รวม) */}
                          {isBadDebtBucket?(
                            <>
                              {/* ค่างวด: ใช้ cellPaidInstall (computeMoneyTotal) เพื่อให้ badge toggle มีผล */}
                              <td className={["px-3 py-1.5 text-right border-r border-gray-200",cellBg].join(" ")}>
                                {sr.key==="paid"&&!isDimmed
                                  ? (()=>{
                                      const visAmt=cellPaidInstall(cell);
                                      const rawAmt=cellPaidInstallRaw(cell);
                                      return visAmt===0?<span className="text-gray-300 text-xs">{fmtMoney(rawAmt)}</span>:renderMoney(visAmt,sr.textColor);
                                    })()
                                  : <span className="text-gray-300 text-xs">—</span>}
                              </td>
                              {/* ขายเครื่อง */}
                              <td className={["px-3 py-1.5 text-right border-r border-gray-200",cellBg].join(" ")}>
                                {sr.key==="paid"&&!isDimmed
                                  ? renderMoney(showBadDebtSale?(cell?.paid.badDebt??0):0, "text-red-700")
                                  : <span className="text-gray-300 text-xs">—</span>}
                              </td>
                              {/* รวม: ค่างวด (visible) + ขายเครื่อง */}
                              <td className={["px-3 py-1.5 text-right border-r border-gray-200",cellBg].join(" ")}>
                                {sr.key==="paid"&&!isDimmed
                                  ? renderMoney(
                                      cellPaidInstall(cell)
                                      +(showBadDebtSale?(cell?.paid.badDebt??0):0),
                                      sr.textColor
                                    )
                                  : renderCellVal(sr.key, val, sr.textColor)}
                              </td>
                            </>
                          ):(
                            <>
                              <td className={["px-3 py-1.5 text-right border-r border-gray-200",cellBg].join(" ")}>
                                {renderCellVal(sr.key, val, sr.textColor)}
                              </td>
                              {/* subtotal col หลัง bucket สุดท้ายของกลุ่ม ปกติ/สงสัยจะเสีย */}
                              {isLast&&g.hasSubtotal&&(()=>{
                                const groupBuckets=g.buckets as readonly string[];
                                const subtotalVal=groupBuckets.reduce((s,gb)=>{
                                  if(isDimmed||hiddenBuckets.has(gb))return s;
                                  return s+cellValue(sr.key,row.buckets[gb]);
                                },0);
                                return(
                                  <td className={["px-3 py-1.5 text-right font-bold border-r border-gray-300",g.subtotalBg].join(" ")}>
                                    {renderCellVal(sr.key, subtotalVal, sr.textColor)}
                                  </td>
                                );
                              })()}
                            </>
                          )}
                        </React.Fragment>
                      );
                    })
                  )}
                </tr>
              ))}
            </React.Fragment>
          );
        })}
      </tbody>
      <tfoot>
        <tr className="border-t-2 border-slate-400 bg-slate-50 font-bold">
          <td className="sticky left-0 z-10 px-3 py-2 text-sm font-bold text-slate-800 bg-slate-100 border-r border-slate-300 whitespace-nowrap">รวมทั้งหมด</td>
          <td className="sticky left-[130px] z-10 px-2 py-2 bg-slate-100 border-r border-slate-300"/>
          <td className="sticky left-[220px] z-10 px-3 py-2 bg-slate-100 border-r border-slate-300"/>
          {BUCKET_GROUPS.map((g)=>
            g.buckets.map((b,bi)=>{
              const isLast=bi===g.buckets.length-1;
              const isBadDebtBucket=g.label==="หนี้เสีย";
              return(
                <React.Fragment key={b}>
                  {isBadDebtBucket?(
                    <>
                      <td className={["px-3 py-2",bucketCellBg(b),"bg-slate-100"].join(" ")}/>
                      <td className={["px-3 py-2",bucketCellBg(b),"bg-slate-100"].join(" ")}/>
                      <td className={["px-3 py-2",bucketCellBg(b),"bg-slate-100"].join(" ")}/>
                    </>
                  ):(
                    <>
                      <td className={["px-3 py-2",bucketCellBg(b),"bg-slate-100"].join(" ")}/>
                      {isLast&&g.hasSubtotal&&<td className={["px-3 py-2",g.subtotalBg,"bg-opacity-80"].join(" ")}/>}
                    </>
                  )}
                </React.Fragment>
              );
            })
          )}
        </tr>
        {COMBINED_SUB_ROWS.map((sr)=>(
          <tr key={sr.key} className={["border-b border-gray-200",sr.totalBg].join(" ")}>
            <td className={["sticky left-0 z-10 px-3 py-1.5 text-xs font-semibold whitespace-nowrap border-r border-gray-300",sr.totalBg].join(" ")}/>
            <td className={["sticky left-[130px] z-10 px-2 py-1.5 text-center text-[11px] font-semibold border-r border-gray-300",sr.totalBg,sr.textColor].join(" ")}>{sr.label}</td>
            <td className={["sticky left-[220px] z-10 px-3 py-1.5 text-right border-r border-gray-300 min-w-[200px]",sr.totalBg].join(" ")}>
              {(()=>{
                const val=gtRowTotal(sr.key);
                const installVal=gtRowTotal("installTotal");
                const targetVal=gtRowTotal("target");
                // หักยอดขายเครื่อง (badDebt) ออกก่อนคำนวณ % ยอดเก็บหนี้
                const gtPaidSaleAmt=DEBT_BUCKETS.reduce((s,b)=>{
                  if(hiddenBuckets.has(b))return s;
                  const bt=grandTotal.bucketTotals[b];
                  return s+(showBadDebtSale?(bt?.paid.badDebt??0):0);
                },0);
                const gtPaidNetVal=val-gtPaidSaleAmt;
                return(
                  <span className="inline-flex items-center justify-end flex-nowrap gap-0.5 whitespace-nowrap">
                    {renderCellVal(sr.key,val,sr.textColor)}
                    {sr.key==="target"&&<PctTag pct={fmtPct(val,installVal)} color="bg-indigo-50 border-indigo-300 text-indigo-700" tooltip={`เป้าเก็บหนี้ ${fmtPct(val,installVal)??""} ของยอดผ่อนรวม`}/>}
                    {sr.key==="paid"&&<>{!hiddenSubRows.has("installTotal")&&<PctTag pct={fmtPct(gtPaidNetVal,installVal)} color="bg-purple-50 border-purple-300 text-purple-700" tooltip={`ยอดเก็บหนี้ (หักขายเครื่อง) ${fmtPct(gtPaidNetVal,installVal)??""} ของยอดผ่อนรวม`}/>}{!hiddenSubRows.has("target")&&<PctTag pct={fmtPct(gtPaidNetVal,targetVal)} color="bg-indigo-50 border-indigo-300 text-indigo-700" tooltip={`ยอดเก็บหนี้ (หักขายเครื่อง) ${fmtPct(gtPaidNetVal,targetVal)??""} ของเป้าเก็บหนี้`}/>}</> }
                    {sr.key==="due"&&<PctTag pct={fmtPct(val,targetVal)} color="bg-orange-50 border-orange-300 text-orange-700" tooltip={`หนี้ค้างชำระ ${fmtPct(val,targetVal)??""} ของเป้าเก็บหนี้`}/>}
                    {sr.key==="notYetDue"&&<PctTag pct={fmtPct(val,installVal)} color="bg-blue-50 border-blue-300 text-blue-700" tooltip={`ยังไม่ถึงกำหนด ${fmtPct(val,installVal)??""} ของยอดผ่อนรวม`}/>}
                  </span>
                );
              })()}
            </td>
            {BUCKET_GROUPS.map((g)=>
              g.buckets.map((b,bi)=>{
                const isBucketHidden=hiddenBuckets.has(b);
                const val=isBucketHidden?0:gtValue(sr.key,b);
                const cellBg=bucketCellBg(b);
                const isLast=bi===g.buckets.length-1;
                const isBadDebtBucket=g.label==="หนี้เสีย";
                const bt=grandTotal.bucketTotals[b];
                return(
                  <React.Fragment key={b}>
                    {isBadDebtBucket?(
                      <>
                        {/* ค่างวด: ใช้ gtPaidInstall (computeMoneyTotal) เพื่อให้ badge toggle มีผล */}
                        <td className={["px-3 py-1.5 text-right border-r border-gray-300",cellBg,"bg-slate-100"].join(" ")}>
                          {sr.key==="paid"&&!isBucketHidden
                            ? (()=>{
                                const visAmt=gtPaidInstall(b);
                                const rawAmt=gtPaidInstallRaw(b);
                                return visAmt===0?<span className="text-gray-200 text-xs">{fmtMoney(rawAmt)}</span>:renderMoney(visAmt,sr.textColor);
                              })()
                            : <span className="text-gray-200 text-xs">—</span>}
                        </td>
                        {/* ขายเครื่อง */}
                        <td className={["px-3 py-1.5 text-right border-r border-gray-300",cellBg,"bg-slate-100"].join(" ")}>
                          {sr.key==="paid"&&!isBucketHidden
                            ? renderMoney(showBadDebtSale&&bt?(bt.paid.badDebt??0):0, "text-red-700")
                            : <span className="text-gray-200 text-xs">—</span>}
                        </td>
                        {/* รวม: ค่างวด (visible) + ขายเครื่อง */}
                        <td className={["px-3 py-1.5 text-right border-r border-gray-300",cellBg,"bg-slate-100"].join(" ")}>
                          {sr.key==="paid"&&!isBucketHidden
                            ? renderMoney(
                                gtPaidInstall(b)
                                +(showBadDebtSale&&bt?(bt.paid.badDebt??0):0),
                                sr.textColor
                              )
                            : renderCellVal(sr.key,val,sr.textColor)}
                        </td>
                      </>
                    ):(
                      <>
                        <td className={["px-3 py-1.5 text-right border-r border-gray-300",cellBg,"bg-slate-100"].join(" ")}>
                          {renderCellVal(sr.key,val,sr.textColor)}
                        </td>
                        {/* subtotal col หลัง bucket สุดท้ายของกลุ่ม ปกติ/สงสัยจะเสีย */}
                        {isLast&&g.hasSubtotal&&(()=>{
                          const groupBuckets=g.buckets as readonly string[];
                          const subtotalVal=groupBuckets.reduce((s,gb)=>{
                            if(hiddenBuckets.has(gb))return s;
                            return s+gtValue(sr.key,gb);
                          },0);
                          return(
                            <td className={["px-3 py-1.5 text-right font-bold border-r border-gray-300",g.subtotalBg,"bg-opacity-80"].join(" ")}>
                              {renderCellVal(sr.key, subtotalVal, sr.textColor)}
                            </td>
                          );
                        })()}
                      </>
                    )}
                  </React.Fragment>
                );
              })
            )}
          </tr>
        ))}
      </tfoot>
    </table>
    </>
  );
}

// ─── DueMonthTable ────────────────────────────────────────────────────────────
// แสดงข้อมูลสรุปรวมโดยกระจายตามเดือนที่ต้องชำระ
const DUE_MONTH_SUB_ROWS: Array<{
  key: "count"|"installTotal"|"target"|"paid"|"due"|"notYetDue";
  label: string;
  rowBg: string;
  textColor: string;
  totalBg: string;
}> = [
  {key:"count",        label:"สัญญา",          rowBg:"bg-slate-50",   textColor:"text-slate-700",   totalBg:"bg-slate-100"},
  {key:"installTotal", label:"ยอดผ่อนรวม",     rowBg:"bg-purple-50",  textColor:"text-purple-800",  totalBg:"bg-purple-100"},
  {key:"target",       label:"เป้าเก็บหนี้",   rowBg:"bg-indigo-50",  textColor:"text-indigo-800",  totalBg:"bg-indigo-100"},
  {key:"paid",         label:"ยอดเก็บหนี้",    rowBg:"bg-green-50",   textColor:"text-green-800",   totalBg:"bg-green-100"},
  {key:"due",          label:"หนี้ค้างชำระ",   rowBg:"bg-orange-50",  textColor:"text-orange-800",  totalBg:"bg-orange-100"},
  {key:"notYetDue",    label:"ยังไม่ถึงกำหนด", rowBg:"bg-blue-50",    textColor:"text-blue-800",    totalBg:"bg-blue-100"},
];

type DueMonthCellLocal={contractCount:number;paid:MoneyBreakdown;target:MoneyBreakdown;due:MoneyBreakdown;notYetDue:MoneyBreakdown;installTotal:MoneyBreakdown;};
type DueMonthRowLocal={approveMonth:string;dueMonths:Record<string,DueMonthCellLocal>;totalCount:number;approvedCount:number;totalPaid:MoneyBreakdown;totalTarget:MoneyBreakdown;totalDue:MoneyBreakdown;totalNotYetDue:MoneyBreakdown;totalInstallTotal:MoneyBreakdown;};

function DueMonthTable({
  rows, allDueMonths,
  hiddenRows, toggleRow,
  hiddenSubRows,
  sortDir, onToggleSort,
  stickyTop,
  paidVis, targetVis, dueVis, notYetDueVis, installVis,
}:{
  rows: DueMonthRowLocal[];
  allDueMonths: string[];
  hiddenRows: Set<string>;
  toggleRow: (month:string)=>void;
  hiddenSubRows: Set<TabKey>;
  sortDir: SortDir;
  onToggleSort: ()=>void;
  stickyTop: number;
  paidVis: Record<MoneyBadgeKey,boolean>;
  targetVis: Record<MoneyBadgeKey,boolean>;
  dueVis: Record<DueBadgeKey,boolean>;
  notYetDueVis: Record<NotYetDueBadgeKey,boolean>;
  installVis: Record<"principal"|"interest"|"fee",boolean>;
}) {
  const SortIcon = sortDir==="asc"?ArrowUp:ArrowDown;

  // คำนวณ cell value ตาม key (badge-aware)
  function cellVal(key: "count"|"installTotal"|"target"|"paid"|"due"|"notYetDue", cell: DueMonthCellLocal|undefined): number {
    if(!cell)return 0;
    if(key==="count")return cell.contractCount;
    if(key==="installTotal")return (installVis.principal?cell.installTotal.principal:0)+(installVis.interest?cell.installTotal.interest:0)+(installVis.fee?cell.installTotal.fee:0);
    if(key==="target")return computeMoneyTotal(cell.target,{...targetVis,discount:false,overpaid:false});
    if(key==="paid")return computeMoneyTotal(cell.paid,paidVis);
    if(key==="due")return computeDueTotal(cell.due,dueVis);
    if(key==="notYetDue")return computeNotYetDueTotal(cell.notYetDue,notYetDueVis);
    return 0;
  }

  function totalVal(key: "count"|"installTotal"|"target"|"paid"|"due"|"notYetDue", row: DueMonthRowLocal): number {
    if(key==="count")return row.approvedCount; // จำนวนสัญญาที่อนุมัติในเดือนนั้น
    if(key==="installTotal")return (installVis.principal?row.totalInstallTotal.principal:0)+(installVis.interest?row.totalInstallTotal.interest:0)+(installVis.fee?row.totalInstallTotal.fee:0);
    if(key==="target")return computeMoneyTotal(row.totalTarget,{...targetVis,discount:false,overpaid:false});
    if(key==="paid")return computeMoneyTotal(row.totalPaid,paidVis);
    if(key==="due")return computeDueTotal(row.totalDue,dueVis);
    if(key==="notYetDue")return computeNotYetDueTotal(row.totalNotYetDue,notYetDueVis);
    return 0;
  }

  // % tag helpers
  function fmtPct(num:number, den:number):string|null {
    if(den===0||num===0)return null;
    return ((num/den)*100).toFixed(1)+"%";
  }
  function PctTag({pct,color,tooltip}:{pct:string|null;color:string;tooltip:string}):React.ReactElement|null {
    if(!pct)return null;
    return(
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={["inline-flex items-center ml-1 px-1.5 py-0.5 rounded text-[10px] font-semibold border cursor-help select-none",color].join(" ")}>{pct}</span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[200px] text-center text-xs">{tooltip}</TooltipContent>
      </Tooltip>
    );
  }

  function renderVal(key: "count"|"installTotal"|"target"|"paid"|"due"|"notYetDue", val: number, textColor: string, installVal?:number, targetVal?:number): React.ReactNode {
    if(key==="count"){
      if(val===0)return <span className="text-gray-300 text-xs">—</span>;
      return <span className="inline-flex items-center justify-center bg-slate-100 text-slate-700 rounded-full px-2.5 py-0.5 text-xs font-bold">{val.toLocaleString()}</span>;
    }
    const numNode = val===0?<span className="text-gray-300 text-xs">—</span>:<span className={["text-xs font-medium",textColor].join(" ")}>{fmtMoney(val)}</span>;
    if(key==="target"||key==="paid"||key==="due"||key==="notYetDue"){
      return(
        <span className="inline-flex items-center justify-end flex-nowrap gap-0.5 whitespace-nowrap">
          {numNode}
          {key==="target"&&<PctTag pct={fmtPct(val,installVal??0)} color="bg-indigo-50 border-indigo-300 text-indigo-700" tooltip={`เป้าเก็บหนี้ ${fmtPct(val,installVal??0)??""} ของยอดผ่อนรวม`}/>}
          {key==="paid"&&<>{!hiddenSubRows.has("installTotal")&&<PctTag pct={fmtPct(val,installVal??0)} color="bg-purple-50 border-purple-300 text-purple-700" tooltip={`ยอดเก็บหนี้ ${fmtPct(val,installVal??0)??""} ของยอดผ่อนรวม`}/>}{!hiddenSubRows.has("target")&&<PctTag pct={fmtPct(val,targetVal??0)} color="bg-indigo-50 border-indigo-300 text-indigo-700" tooltip={`ยอดเก็บหนี้ ${fmtPct(val,targetVal??0)??""} ของเป้าเก็บหนี้`}/>}</> }
          {key==="due"&&<PctTag pct={fmtPct(val,targetVal??0)} color="bg-orange-50 border-orange-300 text-orange-700" tooltip={`หนี้ค้างชำระ ${fmtPct(val,targetVal??0)??""} ของเป้าเก็บหนี้`}/> }
          {key==="notYetDue"&&<PctTag pct={fmtPct(val,installVal??0)} color="bg-blue-50 border-blue-300 text-blue-700" tooltip={`ยังไม่ถึงกำหนด ${fmtPct(val,installVal??0)??""} ของยอดผ่อนรวม`}/>}
        </span>
      );
    }
    return numNode;
  }

  // grand total per due month
  const grandTotalByDueMonth = useMemo(()=>{
    const result: Record<string, DueMonthCellLocal> = {};
    for(const dm of allDueMonths){
      result[dm]={contractCount:0,paid:emptyMoney(),target:emptyMoney(),due:emptyMoney(),notYetDue:emptyMoney(),installTotal:emptyMoney()};
    }
    for(const row of rows){
      if(hiddenRows.has(row.approveMonth))continue;
      for(const dm of allDueMonths){
        const cell=row.dueMonths[dm];
        if(!cell)continue;
        result[dm].contractCount+=cell.contractCount;
        for(const k of Object.keys(emptyMoney()) as (keyof MoneyBreakdown)[]){
          result[dm].paid[k]+=cell.paid[k];
          result[dm].target[k]+=cell.target[k];
          result[dm].due[k]+=cell.due[k];
          result[dm].notYetDue[k]+=cell.notYetDue[k];
          result[dm].installTotal[k]+=cell.installTotal[k];
        }
      }
    }
    return result;
  },[rows,allDueMonths,hiddenRows]);

  const grandTotalOverall = useMemo(()=>{
    let count=0;const paid=emptyMoney();const target=emptyMoney();const due=emptyMoney();const notYetDue=emptyMoney();const installTotal=emptyMoney();
    for(const row of rows){
      if(hiddenRows.has(row.approveMonth))continue;
      count+=row.approvedCount; // สัญญาที่อนุมัติ (ไม่นับซ้ำ)
      for(const k of Object.keys(emptyMoney()) as (keyof MoneyBreakdown)[]){
        paid[k]+=row.totalPaid[k];target[k]+=row.totalTarget[k];due[k]+=row.totalDue[k];
        notYetDue[k]+=row.totalNotYetDue[k];installTotal[k]+=row.totalInstallTotal[k];
      }
    }
    return {totalCount:count,totalPaid:paid,totalTarget:target,totalDue:due,totalNotYetDue:notYetDue,totalInstallTotal:installTotal};
  },[rows,hiddenRows]);

  const visSubRows = DUE_MONTH_SUB_ROWS.filter(sr=>sr.key==="count"||!hiddenSubRows.has(sr.key));
  const minWidth = 130+90+90+(allDueMonths.length*110);

  return(
    <table className="w-full text-xs border-collapse" style={{minWidth:`${minWidth}px`}}>
      <thead className="sticky z-20" style={{top:`${stickyTop}px`}}>
        <tr>
          <th rowSpan={2} className="sticky left-0 z-30 px-3 py-2 text-left font-semibold whitespace-nowrap bg-teal-800 text-white border-r border-teal-600 min-w-[130px]">
            <button type="button" onClick={onToggleSort} className="flex items-center gap-1 hover:opacity-80 transition-opacity" title={sortDir==="asc"?"เรียงใหม่→เก่า":"เรียงเก่า→ใหม่"}>
              เดือน-ปีที่อนุมัติ<SortIcon className="w-3.5 h-3.5 text-teal-300"/>
            </button>
          </th>
          <th rowSpan={2} className="sticky left-[130px] z-30 px-3 py-2 text-center font-semibold whitespace-nowrap bg-teal-700 text-white border-r border-teal-500 min-w-[90px]">
            หัวข้อ
          </th>
          <th rowSpan={2} className="sticky left-[220px] z-30 px-3 py-2 text-right font-semibold whitespace-nowrap bg-teal-700 text-white border-r border-teal-500 min-w-[90px]">
            รวม
          </th>
          {/* เดือนที่ต้องชำระ header */}
          <th colSpan={allDueMonths.length} className="px-2 py-1.5 text-center font-semibold text-white whitespace-nowrap bg-teal-600 border-r border-white/30">
            เดือนที่ต้องชำระ
          </th>
        </tr>
        <tr>
          {allDueMonths.map((dm)=>(
            <th key={dm} className="px-2 py-1.5 text-center font-semibold text-white whitespace-nowrap min-w-[110px] border-r border-white/20 bg-teal-600">
              <span className="text-[10px]">{fmtMonthYear(dm)}</span>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row)=>{
          const isHiddenRow=hiddenRows.has(row.approveMonth);
          return(
            <React.Fragment key={row.approveMonth}>
              {visSubRows.map((sr,srIdx)=>(
                <tr key={sr.key} className={["border-b border-gray-100 transition-colors",srIdx===0?"border-t-2 border-t-gray-300":"",isHiddenRow?"opacity-40":"",sr.rowBg].join(" ")}>
                  {/* เดือน — rowSpan */}
                  {srIdx===0&&(
                    <td rowSpan={visSubRows.length} className="sticky left-0 z-10 px-3 py-2 text-sm font-semibold whitespace-nowrap bg-white border-r border-gray-200 min-w-[130px] align-middle">
                      <div className="flex items-center gap-1.5">
                        <button type="button" onClick={()=>toggleRow(row.approveMonth)} title={isHiddenRow?"แสดงแถวนี้":"ซ่อนแถวนี้"} className="hover:opacity-70 transition-opacity">
                          {isHiddenRow?<EyeOff className="w-3.5 h-3.5 text-gray-400"/>:<Eye className="w-3.5 h-3.5 text-gray-400"/>}
                        </button>
                        <span className="text-gray-800">{fmtMonthYear(row.approveMonth)}</span>
                      </div>
                    </td>
                  )}
                  {/* หัวข้อ */}
                  <td className={["sticky left-[130px] z-10 px-2 py-1.5 text-center whitespace-nowrap border-r border-gray-200 font-medium text-[11px] min-w-[90px]",sr.totalBg,sr.textColor].join(" ")}>
                    {sr.label}
                  </td>
                  {/* รวม */}
                  <td className={["sticky left-[220px] z-10 px-3 py-1.5 text-right border-r border-gray-200 min-w-[150px]",sr.totalBg].join(" ")}>
                    {renderVal(sr.key, isHiddenRow?0:totalVal(sr.key,row), sr.textColor, isHiddenRow?0:totalVal("installTotal",row), isHiddenRow?0:totalVal("target",row))}
                  </td>
                  {/* due month cells */}
                  {allDueMonths.map((dm)=>{
                    const cell=row.dueMonths[dm];
                    const val=isHiddenRow?0:cellVal(sr.key,cell);
                    const installCellVal=isHiddenRow?0:cellVal("installTotal",cell);
                    const targetCellVal=isHiddenRow?0:cellVal("target",cell);
                    const dmBg=dm===new Date().toISOString().slice(0,7)?"bg-yellow-50":"";
                    return(
                      <td key={dm} className={["px-3 py-1.5 text-right border-r border-gray-200",dmBg].join(" ")}>
                        {renderVal(sr.key, val, sr.textColor, installCellVal, targetCellVal)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </React.Fragment>
          );
        })}
      </tbody>
      <tfoot>
        {visSubRows.map((sr,srIdx)=>(
          <tr key={sr.key} className={["border-b border-gray-200 font-bold",srIdx===0?"border-t-2 border-slate-400":"",sr.totalBg].join(" ")}>
            {srIdx===0&&(
              <td rowSpan={visSubRows.length} className="sticky left-0 z-10 px-3 py-2 text-sm font-bold text-slate-800 bg-slate-100 border-r border-slate-300 whitespace-nowrap align-middle">
                รวมทั้งหมด
              </td>
            )}
            <td className={["sticky left-[130px] z-10 px-2 py-1.5 text-center text-[11px] border-r border-slate-300",sr.totalBg,sr.textColor].join(" ")}>
              {sr.label}
            </td>
            <td className={["sticky left-[220px] z-10 px-3 py-1.5 text-right border-r border-slate-300 min-w-[150px]",sr.totalBg].join(" ")}>
              {renderVal(sr.key,
                sr.key==="count"?grandTotalOverall.totalCount:
                sr.key==="installTotal"?(installVis.principal?grandTotalOverall.totalInstallTotal.principal:0)+(installVis.interest?grandTotalOverall.totalInstallTotal.interest:0)+(installVis.fee?grandTotalOverall.totalInstallTotal.fee:0):
                sr.key==="target"?computeMoneyTotal(grandTotalOverall.totalTarget,{...targetVis,discount:false,overpaid:false}):
                sr.key==="paid"?computeMoneyTotal(grandTotalOverall.totalPaid,paidVis):
                sr.key==="due"?computeDueTotal(grandTotalOverall.totalDue,dueVis):
                computeNotYetDueTotal(grandTotalOverall.totalNotYetDue,notYetDueVis),
                sr.textColor,
                (installVis.principal?grandTotalOverall.totalInstallTotal.principal:0)+(installVis.interest?grandTotalOverall.totalInstallTotal.interest:0)+(installVis.fee?grandTotalOverall.totalInstallTotal.fee:0),
                computeMoneyTotal(grandTotalOverall.totalTarget,{...targetVis,discount:false,overpaid:false})
              )}
            </td>
            {allDueMonths.map((dm)=>{
              const cell=grandTotalByDueMonth[dm];
              const val=cellVal(sr.key,cell);
              const installGtVal=cellVal("installTotal",cell);
              const targetGtVal=cellVal("target",cell);
              return(
                <td key={dm} className={["px-3 py-1.5 text-right border-r border-slate-300 font-bold",sr.totalBg].join(" ")}>
                  {renderVal(sr.key, val, sr.textColor, installGtVal, targetGtVal)}
                </td>
              );
            })}
          </tr>
        ))}
      </tfoot>
    </table>
  );
}

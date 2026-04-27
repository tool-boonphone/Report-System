/**
 * MonthlySummary — สรุปรายเดือน (Phase 83)
 *
 * แถบจำนวนสัญญา:
 *   เดือน-ปีที่อนุมัติ | สัญญา(รวม) | กลุ่มปกติ[เกิน1-7|เกิน8-14|เกิน15-30|เกิน31-60|รวม] |
 *   กลุ่มสงสัย[เกิน61-90|เกิน>90|รวม] | ระงับสัญญา | สิ้นสุดสัญญา | หนี้เสีย
 *
 * แถบยอดชำระแล้ว / ยอดค้างชำระ:
 *   กลุ่มหนี้เสีย → 3 sub-cols: ค่างวด | ขายเครื่อง | รวม
 *
 * Filters:
 *   - วันที่อนุมัติสัญญา (exact date)
 *   - เดือน-ปี (multi-select)
 *   - iOS / Android
 *   - ประเภทสินค้า
 *
 * UX:
 *   - ลบ refresh ออกจากแต่ละแถบ (มีแค่ใน nav)
 *   - Export Excel (สีเขียว) ใน nav row เดียวกับแถบ
 *   - sticky header (ไม่ถึง nav)
 *   - เรียงเดือนเก่า→ใหม่ (toggle ได้)
 *   - eye toggle ทั้งหมด / รายเดือน (ปิด = แสดง 0)
 *   - ตัด "รวมทั้งหมด" คอลัมน์ขวาสุดออก
 *   - row ผลรวมด้านล่างสุด sticky bottom
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
  Eye, EyeOff, Gavel, Percent, RefreshCw, Smartphone, Tag, TrendingUp, X,
  ArrowUpDown, ArrowUp, ArrowDown,
} from "lucide-react";
import { toast } from "sonner";
import * as XLSX from "xlsx";

// ─── Constants ───────────────────────────────────────────────────────────────
const DEBT_BUCKETS = [
  "ปกติ","เกิน 1-7","เกิน 8-14","เกิน 15-30","เกิน 31-60",
  "เกิน 61-90","เกิน >90","ระงับสัญญา","สิ้นสุดสัญญา","หนี้เสีย",
] as const;
type DebtBucket = (typeof DEBT_BUCKETS)[number];

// กลุ่มสำหรับ header (ตาม spec)
// normal: ปกติ / เกิน 1-7 / เกิน 8-14 / เกิน 15-30 / เกิน 31-60 + รวม
// suspect: เกิน 61-90 / เกิน >90 + รวม
// standalone: ระงับสัญญา | สิ้นสุดสัญญา | หนี้เสีย
type ColGroup = { key: string; label: string; buckets: DebtBucket[]; headerBg: string; hasSubtotal: boolean };
const COL_GROUPS: ColGroup[] = [
  { key:"normal",     label:"ปกติ",         buckets:["ปกติ","เกิน 1-7","เกิน 8-14","เกิน 15-30","เกิน 31-60"], headerBg:"bg-green-700",  hasSubtotal:true  },
  { key:"suspect",    label:"สงสัยจะเสีย", buckets:["เกิน 61-90","เกิน >90"],                                   headerBg:"bg-orange-700", hasSubtotal:true  },
  { key:"standalone", label:"",             buckets:["ระงับสัญญา","สิ้นสุดสัญญา","หนี้เสีย"],                   headerBg:"bg-gray-700",   hasSubtotal:false },
];

// ─── Types ────────────────────────────────────────────────────────────────────
type MoneyBreakdown = {
  principal:number; interest:number; fee:number; penalty:number;
  unlockFee:number; discount:number; overpaid:number;
  badDebt:number; badDebtInstallment:number; total:number;
};
type SummaryCell = { contractCount:number; paid:MoneyBreakdown; due:MoneyBreakdown };
type SummaryRow  = { approveMonth:string; buckets:Record<string,SummaryCell>; totalCount:number; totalPaid:MoneyBreakdown; totalDue:MoneyBreakdown };
type TabKey      = "count"|"paid"|"due";
type PaidBadgeKey = "principal"|"interest"|"fee"|"penalty"|"unlockFee"|"discount"|"overpaid";
type DueBadgeKey  = "principal"|"interest"|"fee"|"penalty";
type GrandTotal   = { bucketTotals:Record<string,{count:number;paid:MoneyBreakdown;due:MoneyBreakdown}>; totalCount:number; totalPaid:MoneyBreakdown; totalDue:MoneyBreakdown };
type SortDir = "asc"|"desc";

// Flat row type (matches router return)
type FlatRow = {
  approveMonth:string; bucket:string; contractCount:number;
  paidPrincipal:number; paidInterest:number; paidFee:number; paidPenalty:number;
  paidUnlockFee:number; paidDiscount:number; paidOverpaid:number;
  paidBadDebt:number; paidBadDebtInstallment:number; paidTotal:number;
  duePrincipal:number; dueInterest:number; dueFee:number; duePenalty:number; dueTotal:number;
};

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
        row.totalDue={principal:fr.duePrincipal,interest:fr.dueInterest,fee:fr.dueFee,penalty:fr.duePenalty,unlockFee:0,discount:0,overpaid:0,badDebt:0,badDebtInstallment:0,total:fr.dueTotal};
      }
      continue;
    }
    if(!monthMap.has(fr.approveMonth))monthMap.set(fr.approveMonth,{approveMonth:fr.approveMonth,buckets:{},totalCount:0,totalPaid:emptyMoney(),totalDue:emptyMoney()});
    const row=monthMap.get(fr.approveMonth)!;
    row.buckets[fr.bucket]={
      contractCount:fr.contractCount,
      paid:{principal:fr.paidPrincipal,interest:fr.paidInterest,fee:fr.paidFee,penalty:fr.paidPenalty,unlockFee:fr.paidUnlockFee,discount:fr.paidDiscount,overpaid:fr.paidOverpaid,badDebt:fr.paidBadDebt,badDebtInstallment:fr.paidBadDebtInstallment,total:fr.paidTotal},
      due:{principal:fr.duePrincipal,interest:fr.dueInterest,fee:fr.dueFee,penalty:fr.duePenalty,unlockFee:0,discount:0,overpaid:0,badDebt:0,badDebtInstallment:0,total:fr.dueTotal},
    };
  }
  return Array.from(monthMap.values()).sort((a,b)=>b.approveMonth.localeCompare(a.approveMonth));
}

// ─── Badge items ──────────────────────────────────────────────────────────────
const PAID_BADGE_ITEMS: Array<{key:PaidBadgeKey;label:string;icon:React.ReactNode;canToggle:boolean}> = [
  { key:"principal", label:"เงินต้น",      icon:<Banknote   className="w-3.5 h-3.5"/>, canToggle:true  },
  { key:"interest",  label:"ดอกเบี้ย",     icon:<Percent    className="w-3.5 h-3.5"/>, canToggle:true  },
  { key:"fee",       label:"ค่าดำเนินการ", icon:<Coins      className="w-3.5 h-3.5"/>, canToggle:true  },
  { key:"penalty",   label:"ค่าปรับ",      icon:<Gavel      className="w-3.5 h-3.5"/>, canToggle:true  },
  { key:"unlockFee", label:"ค่าปลดล็อก",   icon:<Tag        className="w-3.5 h-3.5"/>, canToggle:true  },
  { key:"discount",  label:"ส่วนลด",       icon:<Tag        className="w-3.5 h-3.5"/>, canToggle:false },
  { key:"overpaid",  label:"ชำระเกิน",     icon:<TrendingUp className="w-3.5 h-3.5"/>, canToggle:true  },
];
const DUE_BADGE_ITEMS: Array<{key:DueBadgeKey;label:string;icon:React.ReactNode;canToggle:boolean}> = [
  { key:"principal", label:"เงินต้น",      icon:<Banknote className="w-3.5 h-3.5"/>, canToggle:true },
  { key:"interest",  label:"ดอกเบี้ย",     icon:<Percent  className="w-3.5 h-3.5"/>, canToggle:true },
  { key:"fee",       label:"ค่าดำเนินการ", icon:<Coins    className="w-3.5 h-3.5"/>, canToggle:true },
  { key:"penalty",   label:"ค่าปรับ",      icon:<Gavel    className="w-3.5 h-3.5"/>, canToggle:true },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function computePaidTotal(m:MoneyBreakdown, v:Record<PaidBadgeKey,boolean>):number {
  return (v.principal?m.principal:0)+(v.interest?m.interest:0)+(v.fee?m.fee:0)+(v.penalty?m.penalty:0)+(v.unlockFee?m.unlockFee:0)+(v.overpaid?m.overpaid:0);
}
function computeDueTotal(m:MoneyBreakdown, v:Record<DueBadgeKey,boolean>):number {
  return (v.principal?m.principal:0)+(v.interest?m.interest:0)+(v.fee?m.fee:0)+(v.penalty?m.penalty:0);
}
function addMoney(a:MoneyBreakdown, b:MoneyBreakdown):MoneyBreakdown {
  return {
    principal:a.principal+b.principal, interest:a.interest+b.interest, fee:a.fee+b.fee,
    penalty:a.penalty+b.penalty, unlockFee:a.unlockFee+b.unlockFee, discount:a.discount+b.discount,
    overpaid:a.overpaid+b.overpaid, badDebt:a.badDebt+b.badDebt,
    badDebtInstallment:a.badDebtInstallment+b.badDebtInstallment, total:a.total+b.total,
  };
}
function emptyMoney():MoneyBreakdown {
  return {principal:0,interest:0,fee:0,penalty:0,unlockFee:0,discount:0,overpaid:0,badDebt:0,badDebtInstallment:0,total:0};
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
  };
  return m[b]??"bg-gray-100 text-gray-700 border-gray-200";
}
function bucketHeaderBg(b:string):string {
  const m:Record<string,string>={
    "ปกติ":"bg-green-700","เกิน 1-7":"bg-yellow-600","เกิน 8-14":"bg-amber-600",
    "เกิน 15-30":"bg-orange-600","เกิน 31-60":"bg-red-600","เกิน 61-90":"bg-red-700",
    "เกิน >90":"bg-rose-800","ระงับสัญญา":"bg-gray-700","สิ้นสุดสัญญา":"bg-blue-700","หนี้เสีย":"bg-gray-800",
  };
  return m[b]??"bg-slate-600";
}
function bucketCellBg(b:string):string {
  const m:Record<string,string>={
    "ปกติ":"bg-green-50/40","เกิน 1-7":"bg-yellow-50/40","เกิน 8-14":"bg-amber-50/40",
    "เกิน 15-30":"bg-orange-50/40","เกิน 31-60":"bg-red-50/40","เกิน 61-90":"bg-red-100/40",
    "เกิน >90":"bg-rose-100/40","ระงับสัญญา":"bg-gray-100/40","สิ้นสุดสัญญา":"bg-blue-50/40","หนี้เสีย":"bg-gray-200/40",
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
/** Multi-select dropdown สำหรับ เดือน-ปี */
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

/** Generic multi-select */
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

/** iOS / Android toggle filter */
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
  const{can}=useAppAuth();const{section}=useSection();const{setActions}=useNavActions();
  const canView=can("debt_report","view");const canExport=can("debt_report","export");
  const[tab,setTab]=useState<TabKey>("count");

  // ── filter state ─────────────────────────────────────────────────────────
  // Tab 1: จำนวนสัญญา
  const[countApproveDate,setCountApproveDate]=useState("");
  const[countApproveMonths,setCountApproveMonths]=useState<Set<string>>(new Set());
  const[countProductType,setCountProductType]=useState<Set<string>>(new Set());
  const[countDeviceFamily,setCountDeviceFamily]=useState("");

  // Tab 2: ยอดชำระแล้ว
  const[paidAtDate,setPaidAtDate]=useState("");
  const[paidAtMonths,setPaidAtMonths]=useState<Set<string>>(new Set());
  const[paidProductType,setPaidProductType]=useState<Set<string>>(new Set());
  const[paidDeviceFamily,setPaidDeviceFamily]=useState("");

  // Tab 3: ยอดค้างชำระ
  const[dueAtDate,setDueAtDate]=useState("");
  const[dueAtMonths,setDueAtMonths]=useState<Set<string>>(new Set());
  const[dueProductType,setDueProductType]=useState<Set<string>>(new Set());
  const[dueDeviceFamily,setDueDeviceFamily]=useState("");

  const[filterOpen,setFilterOpen]=useState(true);
  // dynamic header height สำหรับ sticky thead
  const headerRef=useRef<HTMLDivElement>(null);
  const[headerH,setHeaderH]=useState(96);
  useEffect(()=>{
    const el=headerRef.current;if(!el)return;
    const ro=new ResizeObserver(()=>setHeaderH(el.getBoundingClientRect().height));
    ro.observe(el);setHeaderH(el.getBoundingClientRect().height);
    return()=>ro.disconnect();
  },[]);

  // badge visibility
  const[paidVis,setPaidVis]=useState<Record<PaidBadgeKey,boolean>>({principal:true,interest:true,fee:true,penalty:true,unlockFee:true,discount:false,overpaid:true});
  const[dueVis,setDueVis]=useState<Record<DueBadgeKey,boolean>>({principal:true,interest:true,fee:true,penalty:true});

  // bucket eye toggle
  const[hiddenBuckets,setHiddenBuckets]=useState<Set<string>>(new Set());
  const toggleBucket=useCallback((b:string)=>{setHiddenBuckets((p)=>{const n=new Set(p);if(n.has(b))n.delete(b);else n.add(b);return n;});},[]);
  const toggleGroup=useCallback((g:ColGroup)=>{setHiddenBuckets((p)=>{const n=new Set(p);const allH=g.buckets.every((b)=>n.has(b));if(allH)g.buckets.forEach((b)=>n.delete(b));else g.buckets.forEach((b)=>n.add(b));return n;});},[]);
  const toggleAll=useCallback(()=>{setHiddenBuckets((p)=>{if(p.size===DEBT_BUCKETS.length)return new Set();return new Set(DEBT_BUCKETS);});},[]);
  // row eye toggle (per-month)
  const[hiddenRows,setHiddenRows]=useState<Set<string>>(new Set());
  const toggleRow=useCallback((month:string)=>{setHiddenRows((p)=>{const n=new Set(p);if(n.has(month))n.delete(month);else n.add(month);return n;});},[]);

  // sort direction
  const[sortDir,setSortDir]=useState<SortDir>("asc");

  // ── query input ───────────────────────────────────────────────────────────
  const queryInput=useMemo(()=>{
    if(!section)return null;
    return{
      section,
      countApproveDate:countApproveDate||undefined,
      countApproveMonths:countApproveMonths.size>0?Array.from(countApproveMonths):undefined,
      countProductType:countProductType.size===1?Array.from(countProductType)[0]:undefined,
      countDeviceFamily:(countDeviceFamily as "iOS"|"Android"|undefined)||undefined,
      paidAtDate:paidAtDate||undefined,
      paidAtMonths:paidAtMonths.size>0?Array.from(paidAtMonths):undefined,
      paidProductType:paidProductType.size===1?Array.from(paidProductType)[0]:undefined,
      paidDeviceFamily:(paidDeviceFamily as "iOS"|"Android"|undefined)||undefined,
      dueAtDate:dueAtDate||undefined,
      dueAtMonths:dueAtMonths.size>0?Array.from(dueAtMonths):undefined,
      dueProductType:dueProductType.size===1?Array.from(dueProductType)[0]:undefined,
      dueDeviceFamily:(dueDeviceFamily as "iOS"|"Android"|undefined)||undefined,
    };
  },[section,countApproveDate,countApproveMonths,countProductType,countDeviceFamily,paidAtDate,paidAtMonths,paidProductType,paidDeviceFamily,dueAtDate,dueAtMonths,dueProductType,dueDeviceFamily]);

  const query=trpc.monthlySummary.get.useQuery(queryInput as any,{enabled:canView&&!!queryInput});

  const rowsJson:string=(query.data?.rowsJson??"[]") as string;
  const productTypes:string[]=(query.data?.productTypes??[]) as string[];
  const rawRows:SummaryRow[]=useMemo(()=>{
    try{const flat:FlatRow[]=JSON.parse(rowsJson);return groupFlatRows(flat);}catch{return[];}
  },[rowsJson]);

  // sort rows
  const rows=useMemo(()=>{
    const sorted=[...rawRows].sort((a,b)=>sortDir==="asc"?a.approveMonth.localeCompare(b.approveMonth):b.approveMonth.localeCompare(a.approveMonth));
    return sorted;
  },[rawRows,sortDir]);

  // derive available months from rawRows for filter options
  const availableMonths=useMemo(()=>rawRows.map((r)=>r.approveMonth).sort((a,b)=>b.localeCompare(a)),[rawRows]);

  // grand total
  const grandTotal=useMemo(()=>{
    const bt:Record<string,{count:number;paid:MoneyBreakdown;due:MoneyBreakdown}>={};
    for(const b of DEBT_BUCKETS)bt[b]={count:0,paid:emptyMoney(),due:emptyMoney()};
    let totalCount=0;const totalPaid=emptyMoney();const totalDue=emptyMoney();
    for(const row of rows){
      totalCount+=row.totalCount;
      for(const k of Object.keys(totalPaid)as(keyof MoneyBreakdown)[]){totalPaid[k]+=row.totalPaid[k];totalDue[k]+=row.totalDue[k];}
      for(const b of DEBT_BUCKETS){const cell=row.buckets[b];if(!cell)continue;bt[b].count+=cell.contractCount;for(const k of Object.keys(totalPaid)as(keyof MoneyBreakdown)[]){bt[b].paid[k]+=cell.paid[k];bt[b].due[k]+=cell.due[k];}}
    }
    return{bucketTotals:bt,totalCount,totalPaid,totalDue};
  },[rows]);

  const grandBadgePaid=useMemo(()=>{let r=emptyMoney();for(const b of DEBT_BUCKETS){const bt=grandTotal.bucketTotals[b];if(bt)r=addMoney(r,bt.paid);}return r;},[grandTotal]);
  const grandBadgeDue=useMemo(()=>{let r=emptyMoney();for(const b of DEBT_BUCKETS){const bt=grandTotal.bucketTotals[b];if(bt)r=addMoney(r,bt.due);}return r;},[grandTotal]);

  // filter counts
  const countFilterCount=[countApproveDate,countApproveMonths.size>0,countProductType.size>0,countDeviceFamily].filter(Boolean).length;
  const paidFilterCount=[paidAtDate,paidAtMonths.size>0,paidProductType.size>0,paidDeviceFamily].filter(Boolean).length;
  const dueFilterCount=[dueAtDate,dueAtMonths.size>0,dueProductType.size>0,dueDeviceFamily].filter(Boolean).length;
  const activeFilterCount=tab==="count"?countFilterCount:tab==="paid"?paidFilterCount:dueFilterCount;

  // ── Export Excel ──────────────────────────────────────────────────────────
  const handleExport=useCallback(()=>{
    if(!canExport){toast.error("คุณไม่มีสิทธิ์ Export");return;}
    try{
      const wb=XLSX.utils.book_new();
      const tabLabel=tab==="count"?"จำนวนสัญญา":tab==="paid"?"ยอดชำระแล้ว":"ยอดค้างชำระ";
      const headers=["เดือน-ปีที่อนุมัติ","สัญญา",...DEBT_BUCKETS];
      const wsData:(string|number)[][]=[headers];
      for(const row of rows){
        const vals:any[]=[fmtMonthYear(row.approveMonth),row.totalCount];
        for(const b of DEBT_BUCKETS){
          const cell=row.buckets[b];
          if(tab==="count")vals.push(cell?.contractCount??0);
          else if(tab==="paid")vals.push(cell?.paid.total??0);
          else vals.push(cell?.due.total??0);
        }
        wsData.push(vals);
      }
      const ws=XLSX.utils.aoa_to_sheet(wsData);
      XLSX.utils.book_append_sheet(wb,ws,tabLabel);
      XLSX.writeFile(wb,`monthly_summary_${tab}_${new Date().toISOString().slice(0,10)}.xlsx`);
      toast.success("Export สำเร็จ");
    }catch{toast.error("Export ล้มเหลว");}
  },[canExport,rows,tab]);

  // ── Nav actions ───────────────────────────────────────────────────────────
  const refetchRef=useRef(query.refetch);
  const handleExportRef=useRef(handleExport);
  refetchRef.current=query.refetch;
  handleExportRef.current=handleExport;

  useEffect(()=>{
    setActions(
      <div className="flex items-center gap-2">
        <SyncStatusBar/>
      </div>
    );
    return()=>setActions(null);
  },[setActions]);

  return(
    <AppShell>
      <div className="flex flex-col" ref={headerRef}>
        {/* ── Tab switcher + Export ─────────────────────────────────────── */}
        <div className="bg-white border-b border-gray-200 px-4 flex items-center gap-0">
          {(["count","paid","due"]as TabKey[]).map((t)=>{
            const labels:Record<TabKey,string>={count:"จำนวนสัญญา",paid:"ยอดชำระแล้ว",due:"ยอดค้างชำระ"};
            const ac:Record<TabKey,string>={count:"border-slate-600 text-slate-700",paid:"border-green-600 text-green-700",due:"border-orange-600 text-orange-700"};
            const fc:Record<TabKey,number>={count:countFilterCount,paid:paidFilterCount,due:dueFilterCount};
            return(
              <button key={t} type="button" onClick={()=>setTab(t)}
                className={["relative px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap",tab===t?ac[t]:"border-transparent text-gray-400 hover:text-gray-600"].join(" ")}>
                {labels[t]}{fc[t]>0&&<span className="ml-1 inline-flex items-center justify-center bg-blue-500 text-white rounded-full w-4 h-4 text-[10px] font-bold">{fc[t]}</span>}
              </button>
            );
          })}
          {/* Export Excel ใน row เดียวกับ tab switcher */}
          {canExport&&(
            <button type="button" onClick={handleExport}
              className="ml-auto flex items-center gap-1.5 h-8 px-3 my-1 text-xs font-medium rounded-md bg-green-600 hover:bg-green-700 text-white transition-colors whitespace-nowrap">
              <Download className="w-3.5 h-3.5"/><span className="hidden sm:inline">Export Excel</span>
            </button>
          )}
        </div>

        {/* ── Filter bar ───────────────────────────────────────────────── */}
        <div className="bg-white border-b border-gray-200 shadow-sm">
          <button type="button" className="w-full flex items-center justify-between px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors" onClick={()=>setFilterOpen((v)=>!v)}>
            <span className="flex items-center gap-1.5">
              <CalendarDays className="w-4 h-4 text-blue-500"/>ตัวกรอง
              {activeFilterCount>0&&<span className="ml-1 inline-flex items-center justify-center bg-blue-500 text-white rounded-full w-4 h-4 text-[10px] font-bold">{activeFilterCount}</span>}
            </span>
            <span className="text-xs text-gray-400">{filterOpen?"▲ ซ่อน":"▼ แสดง"}</span>
          </button>
          {filterOpen&&(
            <div className="px-4 pb-3 pt-1 flex flex-wrap items-center gap-2">
              {tab==="count"&&(
                <>
                  {/* วันที่อนุมัติ (exact) */}
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
                  {/* เดือน-ปี multi */}
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-gray-500 whitespace-nowrap">เดือน-ปี:</span>
                    <MonthMultiSelect selected={countApproveMonths} onChange={(v)=>{setCountApproveMonths(v);if(v.size>0)setCountApproveDate("");}} options={availableMonths}/>
                    {countApproveMonths.size>0&&<button type="button" onClick={()=>setCountApproveMonths(new Set())} className="flex items-center justify-center w-6 h-6 rounded-full bg-gray-100 hover:bg-red-100 text-gray-400 hover:text-red-500"><X className="w-3.5 h-3.5"/></button>}
                  </div>
                  {/* iOS/Android */}
                  <DeviceFamilyFilter value={countDeviceFamily} onChange={setCountDeviceFamily}/>
                  {/* ประเภทสินค้า */}
                  <MultiSelectFilter label="ประเภทสินค้า" selected={countProductType} onChange={setCountProductType} options={productTypes} placeholder="ทุกประเภทสินค้า"/>
                  {countFilterCount>0&&(
                    <button type="button" onClick={()=>{setCountApproveDate("");setCountApproveMonths(new Set());setCountProductType(new Set());setCountDeviceFamily("");}}
                      className="flex items-center gap-1 h-9 px-2.5 rounded-md border border-red-200 bg-red-50 text-red-600 text-xs hover:bg-red-100 transition-colors">
                      <X className="w-3.5 h-3.5"/>ล้างทั้งหมด
                    </button>
                  )}
                </>
              )}
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
                    <button type="button" onClick={()=>{setPaidAtDate("");setPaidAtMonths(new Set());setPaidProductType(new Set());setPaidDeviceFamily("");}}
                      className="flex items-center gap-1 h-9 px-2.5 rounded-md border border-red-200 bg-red-50 text-red-600 text-xs hover:bg-red-100 transition-colors">
                      <X className="w-3.5 h-3.5"/>ล้างทั้งหมด
                    </button>
                  )}
                </>
              )}
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
                    <button type="button" onClick={()=>{setDueAtDate("");setDueAtMonths(new Set());setDueProductType(new Set());setDueDeviceFamily("");}}
                      className="flex items-center gap-1 h-9 px-2.5 rounded-md border border-red-200 bg-red-50 text-red-600 text-xs hover:bg-red-100 transition-colors">
                      <X className="w-3.5 h-3.5"/>ล้างทั้งหมด
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        {/* ── Badge: paid ───────────────────────────────────────────────── */}
        {tab==="paid"&&(
          <div className="bg-green-50/60 border-b border-green-200 px-4 py-2 flex flex-wrap items-center gap-2">
            {PAID_BADGE_ITEMS.map(({key,label,icon,canToggle})=>{const isOn=paidVis[key];const val=grandBadgePaid[key as keyof MoneyBreakdown];return(
              <button key={key} type="button" onClick={()=>{if(!canToggle)return;setPaidVis((p)=>({...p,[key]:!p[key]}));}}
                title={canToggle?(isOn?`ซ่อน${label}`:`แสดง${label}`):`${label} (ปิดเสมอ)`}
                className={["flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border transition-colors",!canToggle?"opacity-40 cursor-not-allowed bg-gray-100 border-gray-200 text-gray-400":isOn?"bg-green-100 border-green-300 text-green-800 hover:bg-green-200":"bg-gray-100 border-gray-200 text-gray-400 hover:bg-gray-200"].join(" ")}>
                {isOn?<Eye className="w-3 h-3"/>:<EyeOff className="w-3 h-3"/>}{icon}<span>{label}</span>
                {isOn&&<span className="font-semibold ml-0.5">{fmtMoney(val)}</span>}
              </button>
            );})}
            <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border bg-green-700 border-green-800 text-white font-semibold">
              <Banknote className="w-3.5 h-3.5"/><span>รวมยอดชำระ</span><span>{fmtMoney(computePaidTotal(grandBadgePaid,paidVis))}</span>
            </div>
          </div>
        )}

        {/* ── Badge: due ────────────────────────────────────────────────── */}
        {tab==="due"&&(
          <div className="bg-orange-50/60 border-b border-orange-200 px-4 py-2 flex flex-wrap items-center gap-2">
            {DUE_BADGE_ITEMS.map(({key,label,icon,canToggle})=>{const isOn=dueVis[key];const val=grandBadgeDue[key as keyof MoneyBreakdown];return(
              <button key={key} type="button" onClick={()=>{if(!canToggle)return;setDueVis((p)=>({...p,[key]:!p[key]}));}}
                title={isOn?`ซ่อน${label}`:`แสดง${label}`}
                className={["flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border transition-colors",isOn?"bg-orange-100 border-orange-300 text-orange-800 hover:bg-orange-200":"bg-gray-100 border-gray-200 text-gray-400 hover:bg-gray-200"].join(" ")}>
                {isOn?<Eye className="w-3 h-3"/>:<EyeOff className="w-3 h-3"/>}{icon}<span>{label}</span>
                {isOn&&<span className="font-semibold ml-0.5">{fmtMoney(val)}</span>}
              </button>
            );})}
            <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border bg-orange-700 border-orange-800 text-white font-semibold">
              <Banknote className="w-3.5 h-3.5"/><span>รวม</span><span>{fmtMoney(computeDueTotal(grandBadgeDue,dueVis))}</span>
            </div>
          </div>
        )}

        {/* ── Table area ────────────────────────────────────────────────── */}
        <div className="pb-12">
          {!canView?(<div className="flex items-center justify-center h-full text-gray-400 text-sm">คุณไม่มีสิทธิ์ดูข้อมูลนี้</div>)
          :query.isLoading?(<div className="flex items-center justify-center h-full gap-2 text-gray-400"><Spinner className="w-5 h-5"/><span className="text-sm">กำลังโหลด...</span></div>)
          :query.error?(<div className="flex flex-col items-center justify-center h-full gap-3 text-red-500"><span className="text-sm">โหลดข้อมูลล้มเหลว: {query.error.message}</span><Button variant="outline" size="sm" onClick={()=>query.refetch()}>ลองใหม่</Button></div>)
          :rows.length===0?(<div className="flex items-center justify-center h-full text-gray-400 text-sm">ไม่มีข้อมูล</div>)
          :(
            <SummaryTable
              tab={tab} rows={rows} grandTotal={grandTotal}
              hiddenBuckets={hiddenBuckets} toggleBucket={toggleBucket} toggleGroup={toggleGroup} toggleAll={toggleAll}
              paidVis={paidVis} dueVis={dueVis}
              sortDir={sortDir} onToggleSort={()=>setSortDir((d)=>d==="asc"?"desc":"asc")}
              hiddenRows={hiddenRows} toggleRow={toggleRow}
            />
          )}
        </div>
      </div>
    </AppShell>
  );
}

// ─── SummaryTable ─────────────────────────────────────────────────────────────
function SummaryTable({tab,rows,grandTotal,hiddenBuckets,toggleBucket,toggleGroup,toggleAll,paidVis,dueVis,sortDir,onToggleSort,hiddenRows,toggleRow}:{
  tab:TabKey;rows:SummaryRow[];grandTotal:GrandTotal;hiddenBuckets:Set<string>;
  toggleBucket:(b:string)=>void;toggleGroup:(g:ColGroup)=>void;toggleAll:()=>void;
  paidVis:Record<PaidBadgeKey,boolean>;dueVis:Record<DueBadgeKey,boolean>;
  sortDir:SortDir;onToggleSort:()=>void;
  hiddenRows:Set<string>;toggleRow:(month:string)=>void;
}) {
  // "หนี้เสีย" bucket ใน paid tab เท่านั้น แยกเป็น 3 sub-cols: ค่างวด | หนี้เสีย | รวม
  // count tab และ due tab = 1 col เดียว
  const isBadDebtExpanded=(b:string)=>tab==="paid"&&b==="หนี้เสีย";
  const bucketColSpan=(b:string)=>isBadDebtExpanded(b)?3:1;

  // cell value helpers
  const cellCountVal=(b:string,cell:SummaryCell|undefined)=>hiddenBuckets.has(b)?0:(cell?.contractCount??0);
  const cellPaidVal=(b:string,cell:SummaryCell|undefined)=>hiddenBuckets.has(b)?0:(cell?computePaidTotal(cell.paid,paidVis):0);
  const cellPaidBadDebtInstall=(b:string,cell:SummaryCell|undefined)=>hiddenBuckets.has(b)?0:(cell?.paid.badDebtInstallment??0);
  const cellPaidBadDebt=(b:string,cell:SummaryCell|undefined)=>hiddenBuckets.has(b)?0:(cell?.paid.badDebt??0);
  const cellDueVal=(b:string,cell:SummaryCell|undefined)=>hiddenBuckets.has(b)?0:(cell?computeDueTotal(cell.due,dueVis):0);
  const cellDueBadDebtInstall=(b:string,cell:SummaryCell|undefined)=>hiddenBuckets.has(b)?0:(cell?.due.total??0);
  const cellDueBadDebt=(_b:string,_cell:SummaryCell|undefined)=>0; // due ไม่มี bad_debt_amount

  // grand total helpers
  const gtCountVal=(b:string)=>{const bt=grandTotal.bucketTotals[b];return hiddenBuckets.has(b)?0:(bt?.count??0);};
  const gtPaidVal=(b:string)=>{const bt=grandTotal.bucketTotals[b];return hiddenBuckets.has(b)?0:(bt?computePaidTotal(bt.paid,paidVis):0);};
  const gtPaidBadDebtInstall=(b:string)=>{const bt=grandTotal.bucketTotals[b];return hiddenBuckets.has(b)?0:(bt?.paid.badDebtInstallment??0);};
  const gtPaidBadDebt=(b:string)=>{const bt=grandTotal.bucketTotals[b];return hiddenBuckets.has(b)?0:(bt?.paid.badDebt??0);};
  const gtDueVal=(b:string)=>{const bt=grandTotal.bucketTotals[b];return hiddenBuckets.has(b)?0:(bt?computeDueTotal(bt.due,dueVis):0);};
  const gtDueBadDebtInstall=(b:string)=>{const bt=grandTotal.bucketTotals[b];return hiddenBuckets.has(b)?0:(bt?.due.total??0);};

  // subtotal buckets (ตาม spec: normal = ปกติ+เกิน 1-7..31-60, suspect = เกิน 61-90..>90)
  const normalBuckets=COL_GROUPS[0].buckets as readonly string[];
  const suspectBuckets=COL_GROUPS[1].buckets as readonly string[];

  function rowNormalCount(row:SummaryRow):number{return normalBuckets.reduce((s,b)=>s+cellCountVal(b,row.buckets[b]),0);}
  function rowNormalPaid(row:SummaryRow):number{return normalBuckets.reduce((s,b)=>s+cellPaidVal(b,row.buckets[b]),0);}
  function rowNormalDue(row:SummaryRow):number{return normalBuckets.reduce((s,b)=>s+cellDueVal(b,row.buckets[b]),0);}
  function rowSuspectCount(row:SummaryRow):number{return suspectBuckets.reduce((s,b)=>s+cellCountVal(b,row.buckets[b]),0);}
  function rowSuspectPaid(row:SummaryRow):number{return suspectBuckets.reduce((s,b)=>s+cellPaidVal(b,row.buckets[b]),0);}
  function rowSuspectDue(row:SummaryRow):number{return suspectBuckets.reduce((s,b)=>s+cellDueVal(b,row.buckets[b]),0);}

  const gtNormalCount=normalBuckets.reduce((s,b)=>s+gtCountVal(b),0);
  const gtNormalPaid=normalBuckets.reduce((s,b)=>s+gtPaidVal(b),0);
  const gtNormalDue=normalBuckets.reduce((s,b)=>s+gtDueVal(b),0);
  const gtSuspectCount=suspectBuckets.reduce((s,b)=>s+gtCountVal(b),0);
  const gtSuspectPaid=suspectBuckets.reduce((s,b)=>s+gtPaidVal(b),0);
  const gtSuspectDue=suspectBuckets.reduce((s,b)=>s+gtDueVal(b),0);

  // "สัญญา" column = รวมของ normal + suspect + standalone
  function rowContractTotal(row:SummaryRow):number{
    return DEBT_BUCKETS.reduce((s,b)=>s+cellCountVal(b,row.buckets[b]),0);
  }
  const gtContractTotal=DEBT_BUCKETS.reduce((s,b)=>s+gtCountVal(b),0);

  function rowPaidTotal(row:SummaryRow):number{return computePaidTotal(row.totalPaid,paidVis);}
  function rowDueTotal(row:SummaryRow):number{return computeDueTotal(row.totalDue,dueVis);}
  const gtPaidTotal=computePaidTotal(grandTotal.totalPaid,paidVis);
  const gtDueTotal=computeDueTotal(grandTotal.totalDue,dueVis);

  // render helpers
  function renderCount(v:number){return v>0?(<span className="inline-flex items-center justify-center bg-slate-200 text-slate-700 rounded-full px-2.5 py-0.5 text-xs font-bold">{v.toLocaleString()}</span>):(<span className="text-gray-300">—</span>);}
  function renderMoney(v:number,colorClass:string){return<span className={v>0?colorClass:"text-gray-300"}>{v>0?fmtMoney(v):"0.00"}</span>;}

  const allHidden=DEBT_BUCKETS.every((b)=>hiddenBuckets.has(b));
  const SortIcon=sortDir==="asc"?ArrowUp:ArrowDown;

  // minWidth calculation
  const minWidth=useMemo(()=>{
    let w=130+90; // เดือน + สัญญา
    for(const g of COL_GROUPS){
      for(const b of g.buckets)w+=isBadDebtExpanded(b)?360:120;
      if(g.hasSubtotal)w+=120;
    }
    return w;
  },[tab]);// eslint-disable-line react-hooks/exhaustive-deps

  return(
    <>
    <table className="w-full text-sm border-collapse" style={{minWidth:`${minWidth}px`}}>
      <thead className="sticky top-0 z-20">
        {/* ── Row 1: group headers ──────────────────────────────────────── */}
        <tr>
          {/* เดือน-ปีที่อนุมัติ */}
          <th rowSpan={3} className="sticky left-0 z-30 px-3 py-2 text-left font-semibold whitespace-nowrap bg-slate-800 text-white border-r border-slate-600 min-w-[130px]">
            <div className="flex items-center gap-1.5">
              <button type="button" onClick={onToggleSort} className="flex items-center gap-1 hover:opacity-80 transition-opacity" title={sortDir==="asc"?"เรียงใหม่→เก่า":"เรียงเก่า→ใหม่"}>
                เดือน-ปีที่อนุมัติ<SortIcon className="w-3.5 h-3.5 text-slate-300"/>
              </button>
              <button type="button" onClick={toggleAll} className="ml-1 hover:opacity-80 transition-opacity" title={allHidden?"แสดงทั้งหมด":"ซ่อนทั้งหมด"}>
                {allHidden?<EyeOff className="w-3.5 h-3.5 text-slate-400"/>:<Eye className="w-3.5 h-3.5 text-slate-400"/>}
              </button>
            </div>
          </th>
          {/* สัญญา / ยอดชำระ / ยอดค้างชำระ — ตาม tab */}
          <th rowSpan={3} className="sticky left-[130px] z-30 px-3 py-2 text-right font-semibold whitespace-nowrap bg-slate-700 text-white border-r border-slate-500 min-w-[90px]">
            {tab==="count"?"สัญญา":tab==="paid"?"ยอดชำระ":"ยอดค้างชำระ"}
          </th>
          {/* กลุ่ม headers */}
          {COL_GROUPS.map((g)=>{
            const bucketSpan=g.buckets.reduce((a,b)=>a+bucketColSpan(b),0);
            const span=bucketSpan+(g.hasSubtotal?1:0);
            if(!g.label){
              // standalone group — render each bucket as its own th (rowSpan=3 = all 3 header rows)
              return g.buckets.map((b)=>(
                <th key={b} rowSpan={3} colSpan={bucketColSpan(b)}
                  className={`px-2 py-1.5 text-center text-xs font-bold text-white border-r border-white/20 ${bucketHeaderBg(b)}`}>
                  <button type="button" onClick={()=>toggleBucket(b)} className="flex items-center justify-center gap-1.5 mx-auto hover:opacity-80 transition-opacity">
                    {hiddenBuckets.has(b)?<EyeOff className="w-3 h-3"/>:<Eye className="w-3 h-3"/>}
                    <span className={`inline-block px-1.5 py-0.5 rounded-full text-[10px] border ${bucketPillClasses(b)}`}>{b}</span>
                  </button>
                </th>
              ));
            }
            const allH=g.buckets.every((b)=>hiddenBuckets.has(b));
            return(
              <th key={g.key} colSpan={span} className={`px-2 py-1.5 text-center text-xs font-bold text-white border-r border-white/20 ${g.headerBg}`}>
                <button type="button" onClick={()=>toggleGroup(g)} className="flex items-center justify-center gap-1.5 mx-auto hover:opacity-80 transition-opacity">
                  {allH?<EyeOff className="w-3 h-3"/>:<Eye className="w-3 h-3"/>}{g.label}
                </button>
              </th>
            );
          })}
        </tr>
        {/* ── Row 2: bucket names + subtotal labels ─────────────────────── */}
        <tr>
          {COL_GROUPS.map((g)=>{
            if(!g.label)return null; // standalone already rendered in row 1
            const subLabel2=g.key==="normal"?"รวม":"รวม";
            const subBg=g.key==="normal"?"bg-green-800":"bg-orange-800";
            return(
              <React.Fragment key={g.key}>
                {g.buckets.map((b)=>(
                  <th key={b} colSpan={bucketColSpan(b)}
                    className={`px-2 py-1.5 text-center text-xs font-semibold text-white whitespace-nowrap min-w-[120px] border-r border-white/10 ${bucketHeaderBg(b)}`}>
                    <div className="flex items-center justify-center gap-1">
                      <button type="button" onClick={()=>toggleBucket(b)} className="hover:opacity-80 transition-opacity">
                        {hiddenBuckets.has(b)?<EyeOff className="w-3 h-3"/>:<Eye className="w-3 h-3"/>}
                      </button>
                      <span className={`inline-block px-1.5 py-0.5 rounded-full text-[10px] border ${bucketPillClasses(b)}`}>{b}</span>
                    </div>
                  </th>
                ))}
                {g.hasSubtotal&&(
                  <th rowSpan={2} className={`px-2 py-1.5 text-center text-xs font-bold text-white whitespace-nowrap min-w-[120px] border-r border-white/20 ${subBg}`}>{subLabel2}</th>
                )}
              </React.Fragment>
            );
          })}
        </tr>
        {/* ── Row 3: sub-label per bucket ───────────────────────────────── */}
        <tr>
          {COL_GROUPS.map((g)=>(
            <React.Fragment key={g.key}>
              {g.buckets.map((b)=>{
                if(isBadDebtExpanded(b)){
                  // paid tab: หนี้เสีย แยกเป็น 3 sub-cols: ค่างวด | หนี้เสีย | รวม
                  return(
                    <React.Fragment key={b}>
                      <th className={`px-2 py-1 text-center text-[10px] font-medium text-white/90 whitespace-nowrap border-r border-white/10 min-w-[120px] ${bucketHeaderBg(b)}`}>ค่างวด</th>
                      <th className={`px-2 py-1 text-center text-[10px] font-medium text-red-200 whitespace-nowrap border-r border-white/10 min-w-[120px] ${bucketHeaderBg(b)}`}>หนี้เสีย</th>
                      <th className={`px-2 py-1 text-center text-[10px] font-medium text-white/80 whitespace-nowrap border-r border-white/10 min-w-[120px] ${bucketHeaderBg(b)}`}>รวม</th>
                    </React.Fragment>
                  );
                }
                if(!g.label)return null; // standalone already has rowSpan=3 (rendered in row 1)
                const subLabel=tab==="count"?"จำนวน":tab==="paid"?"ยอดชำระ":"ยอดค้าง";
                return<th key={b} className={`px-2 py-1 text-center text-[10px] font-medium text-white/80 whitespace-nowrap border-r border-white/10 ${bucketHeaderBg(b)}`}>{subLabel}</th>;
              })}
            </React.Fragment>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-100">
        {rows.map((row)=>(
          <tr key={row.approveMonth} className="hover:bg-blue-50/30 transition-colors">
            {/* เดือน-ปี */}
            <td className="sticky left-0 z-10 px-3 py-2.5 font-medium text-slate-800 whitespace-nowrap border-r border-gray-200 bg-white">
              <div className="flex items-center gap-1.5">
                <button type="button" onClick={()=>toggleRow(row.approveMonth)} className="shrink-0 hover:opacity-70 transition-opacity" title={hiddenRows.has(row.approveMonth)?"แสดงแถวนี้":"ซ่อนแถวนี้"}>
                  {hiddenRows.has(row.approveMonth)?<EyeOff className="w-3.5 h-3.5 text-slate-400"/>:<Eye className="w-3.5 h-3.5 text-slate-400"/>}
                </button>
                <span className={hiddenRows.has(row.approveMonth)?"text-slate-400 line-through":undefined}>{fmtMonthYear(row.approveMonth)}</span>
              </div>
            </td>
            {/* สัญญา (รวม) */}
            <td className="sticky left-[130px] z-10 px-3 py-2.5 text-right border-r border-gray-200 bg-white">
              {hiddenRows.has(row.approveMonth)?renderCount(0):tab==="count"?renderCount(rowContractTotal(row)):tab==="paid"?renderMoney(rowPaidTotal(row),"text-green-800 font-medium"):renderMoney(rowDueTotal(row),"text-orange-800 font-medium")}
            </td>
            {/* Bucket cells */}
            {COL_GROUPS.map((g,gi)=>(
              <React.Fragment key={g.key}>
                {g.buckets.map((b)=>{
                  const cell=row.buckets[b];const cellBg=bucketCellBg(b);
                  const isHiddenRow=hiddenRows.has(row.approveMonth);
                  if(tab==="count"){
                    const v=isHiddenRow?0:cellCountVal(b,cell);
                    return<td key={b} className={`px-3 py-2.5 text-right ${cellBg}`}>{renderCount(v)}</td>;
                  }
                  if(tab==="paid"){
                    if(isBadDebtExpanded(b)){
                      const install=isHiddenRow?0:cellPaidBadDebtInstall(b,cell);
                      const sale=isHiddenRow?0:cellPaidBadDebt(b,cell);
                      const total=install+sale;
                      return(
                        <React.Fragment key={b}>
                          <td className={`px-3 py-2.5 text-right ${cellBg}`}>{renderMoney(install,"text-green-800 font-medium")}</td>
                          <td className={`px-3 py-2.5 text-right ${cellBg}`}>{renderMoney(sale,"text-red-700 font-medium")}</td>
                          <td className={`px-3 py-2.5 text-right font-semibold ${cellBg}`}>{renderMoney(total,"text-gray-800")}</td>
                        </React.Fragment>
                      );
                    }
                    const v=isHiddenRow?0:cellPaidVal(b,cell);
                    return<td key={b} className={`px-3 py-2.5 text-right ${cellBg}`}>{renderMoney(v,"text-green-800 font-medium")}</td>;
                  }
                  // due tab
                  if(isBadDebtExpanded(b)){
                    const install=isHiddenRow?0:cellDueBadDebtInstall(b,cell);
                    const sale=isHiddenRow?0:cellDueBadDebt(b,cell);
                    const total=install+sale;
                    return(
                      <React.Fragment key={b}>
                        <td className={`px-3 py-2.5 text-right ${cellBg}`}>{renderMoney(install,"text-orange-800 font-medium")}</td>
                        <td className={`px-3 py-2.5 text-right ${cellBg}`}>{renderMoney(sale,"text-red-700 font-medium")}</td>
                        <td className={`px-3 py-2.5 text-right font-semibold ${cellBg}`}>{renderMoney(total,"text-gray-800")}</td>
                      </React.Fragment>
                    );
                  }
                  const v=isHiddenRow?0:cellDueVal(b,cell);
                  return<td key={b} className={`px-3 py-2.5 text-right ${cellBg}`}>{renderMoney(v,"text-orange-800 font-medium")}</td>;
                })}
                {/* Subtotal column */}
                {g.hasSubtotal&&(()=>{
                  const subBg=gi===0?"bg-green-50/60":"bg-orange-50/60";
                  const isHiddenRow=hiddenRows.has(row.approveMonth);
                  if(tab==="count"){const v=isHiddenRow?0:(gi===0?rowNormalCount(row):rowSuspectCount(row));return<td className={`px-3 py-2.5 text-right font-bold ${subBg} border-r border-gray-200`}>{renderCount(v)}</td>;}
                  if(tab==="paid"){const v=isHiddenRow?0:(gi===0?rowNormalPaid(row):rowSuspectPaid(row));return<td className={`px-3 py-2.5 text-right font-bold ${subBg} border-r border-gray-200`}>{renderMoney(v,"text-green-900")}</td>;}
                  const v=isHiddenRow?0:(gi===0?rowNormalDue(row):rowSuspectDue(row));return<td className={`px-3 py-2.5 text-right font-bold ${subBg} border-r border-gray-200`}>{renderMoney(v,"text-orange-900")}</td>;
                })()}
              </React.Fragment>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
    {/* ── Fixed Grand Total Bar ─────────────────────────────────────── */}
    <div className="fixed bottom-0 left-0 right-0 z-40 overflow-x-auto border-t-2 border-slate-400 bg-slate-100 shadow-[0_-2px_8px_rgba(0,0,0,0.12)]">
      <table className="text-sm font-bold" style={{minWidth:`${minWidth}px`}}>
        <tbody>
          <tr>
            <td className="sticky left-0 z-20 px-3 py-2.5 text-slate-800 whitespace-nowrap border-r border-slate-300 bg-slate-200 min-w-[130px]">รวมทั้งหมด</td>
            <td className="sticky left-[130px] z-20 px-3 py-2.5 text-right border-r border-slate-300 bg-slate-200 min-w-[90px]">
              {tab==="count"?(<span className="inline-flex items-center justify-center bg-slate-400 text-white rounded-full px-2.5 py-0.5 text-xs font-bold">{gtContractTotal.toLocaleString()}</span>):tab==="paid"?renderMoney(gtPaidTotal,"text-green-900"):renderMoney(gtDueTotal,"text-orange-900")}
            </td>
            {COL_GROUPS.map((g,gi)=>(
              <React.Fragment key={g.key}>
                {g.buckets.map((b)=>{
                  const cellBg=bucketCellBg(b);
                  if(tab==="count"){const v=gtCountVal(b);return<td key={b} className={`px-3 py-2.5 text-right ${cellBg} bg-slate-100 min-w-[120px]`}><span className="inline-flex items-center justify-center bg-slate-200 text-slate-800 rounded-full px-2.5 py-0.5 text-xs font-bold">{v.toLocaleString()}</span></td>;}
                  if(tab==="paid"){
                    if(isBadDebtExpanded(b)){const install=gtPaidBadDebtInstall(b);const sale=gtPaidBadDebt(b);const total=install+sale;return(<React.Fragment key={b}><td className={`px-3 py-2.5 text-right ${cellBg} bg-slate-100 min-w-[120px]`}>{renderMoney(install,"text-green-900")}</td><td className={`px-3 py-2.5 text-right ${cellBg} bg-slate-100 min-w-[120px]`}>{renderMoney(sale,"text-red-700")}</td><td className={`px-3 py-2.5 text-right font-bold ${cellBg} bg-slate-100 min-w-[120px]`}>{renderMoney(total,"text-gray-900")}</td></React.Fragment>);}
                    const v=gtPaidVal(b);return<td key={b} className={`px-3 py-2.5 text-right ${cellBg} bg-slate-100 min-w-[120px]`}>{renderMoney(v,"text-green-900")}</td>;
                  }
                  if(isBadDebtExpanded(b)){const install=gtDueBadDebtInstall(b);const sale=0;const total=install+sale;return(<React.Fragment key={b}><td className={`px-3 py-2.5 text-right ${cellBg} bg-slate-100 min-w-[120px]`}>{renderMoney(install,"text-orange-900")}</td><td className={`px-3 py-2.5 text-right ${cellBg} bg-slate-100 min-w-[120px]`}>{renderMoney(sale,"text-red-700")}</td><td className={`px-3 py-2.5 text-right font-bold ${cellBg} bg-slate-100 min-w-[120px]`}>{renderMoney(total,"text-gray-900")}</td></React.Fragment>);}
                  const v=gtDueVal(b);return<td key={b} className={`px-3 py-2.5 text-right ${cellBg} bg-slate-100 min-w-[120px]`}>{renderMoney(v,"text-orange-900")}</td>;
                })}
                {g.hasSubtotal&&(()=>{
                  const subBg=gi===0?"bg-green-100":"bg-orange-100";
                  if(tab==="count"){const v=gi===0?gtNormalCount:gtSuspectCount;return<td className={`px-3 py-2.5 text-right font-bold ${subBg} border-r border-slate-300 min-w-[120px]`}><span className="inline-flex items-center justify-center bg-slate-300 text-slate-800 rounded-full px-2.5 py-0.5 text-xs font-bold">{v.toLocaleString()}</span></td>;}
                  if(tab==="paid"){const v=gi===0?gtNormalPaid:gtSuspectPaid;return<td className={`px-3 py-2.5 text-right font-bold ${subBg} border-r border-slate-300 min-w-[120px]`}>{renderMoney(v,"text-green-900")}</td>;}
                  const v=gi===0?gtNormalDue:gtSuspectDue;return<td className={`px-3 py-2.5 text-right font-bold ${subBg} border-r border-slate-300 min-w-[120px]`}>{renderMoney(v,"text-orange-900")}</td>;
                })()}
              </React.Fragment>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
    </>
  );
}

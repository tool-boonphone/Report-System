/**
 * MonthlySummary — สรุปรายเดือน (Phase 81)
 * - ตัดสัญญาสถานะ "ยกเลิกสัญญา" ออก (ใน backend)
 * - eye toggle แสดง 0 แทนซ่อนคอลัมน์
 * - เพิ่มคอลัมน์ รวม(ปกติ) และ รวม(สงสัย) ระหว่าง group
 * - ลบคำว่า "สัญญา" ออกจาก sub-header
 * - badge คำนวณจากทุก bucket (ไม่กรองตาม hidden)
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
import { Banknote, CalendarDays, Check, ChevronsUpDown, Coins, Download, Eye, EyeOff, Gavel, Percent, RefreshCw, Tag, TrendingUp, X } from "lucide-react";
import { toast } from "sonner";
import * as XLSX from "xlsx";

// ─── Constants ───────────────────────────────────────────────────────────────
const DEBT_BUCKETS = ["ปกติ","เกิน 1-7","เกิน 8-14","เกิน 15-30","เกิน 31-60","เกิน 61-90","เกิน >90","ระงับสัญญา","สิ้นสุดสัญญา","หนี้เสีย"] as const;
type DebtBucket = (typeof DEBT_BUCKETS)[number];

// กลุ่มสำหรับ header row 1 (group toggle)
type ColGroup = { key: string; label: string; buckets: DebtBucket[]; headerBg: string };
const COL_GROUPS: ColGroup[] = [
  { key:"normal",  label:"ปกติ",        buckets:["ปกติ","เกิน 1-7","เกิน 8-14","เกิน 15-30","เกิน 31-60"], headerBg:"bg-green-700" },
  { key:"suspect", label:"สงสัยจะเสีย", buckets:["เกิน 61-90","เกิน >90","ระงับสัญญา","สิ้นสุดสัญญา"],    headerBg:"bg-orange-700" },
  { key:"bad",     label:"หนี้เสีย",    buckets:["หนี้เสีย"],                                                headerBg:"bg-gray-800" },
];

// ─── Types ────────────────────────────────────────────────────────────────────
type MoneyBreakdown = {
  principal:number; interest:number; fee:number; penalty:number;
  unlockFee:number; discount:number; overpaid:number; badDebt:number; total:number;
};
type SummaryCell = { contractCount:number; paid:MoneyBreakdown; due:MoneyBreakdown };
type SummaryRow  = { approveMonth:string; buckets:Record<string,SummaryCell>; totalCount:number; totalPaid:MoneyBreakdown; totalDue:MoneyBreakdown };
type TabKey      = "count"|"paid"|"due";
type PaidBadgeKey = "principal"|"interest"|"fee"|"penalty"|"discount"|"overpaid";
type DueBadgeKey  = "principal"|"interest"|"fee"|"penalty";
type GrandTotal   = { bucketTotals:Record<string,{count:number;paid:MoneyBreakdown;due:MoneyBreakdown}>; totalCount:number; totalPaid:MoneyBreakdown; totalDue:MoneyBreakdown };

// Flat row type (matches router return — หลีกเลี่ยง superjson depth limit)
type FlatRow = {
  approveMonth:string; bucket:string; contractCount:number;
  paidPrincipal:number; paidInterest:number; paidFee:number; paidPenalty:number;
  paidUnlockFee:number; paidDiscount:number; paidOverpaid:number; paidBadDebt:number; paidTotal:number;
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
        row.totalPaid={principal:fr.paidPrincipal,interest:fr.paidInterest,fee:fr.paidFee,penalty:fr.paidPenalty,unlockFee:fr.paidUnlockFee,discount:fr.paidDiscount,overpaid:fr.paidOverpaid,badDebt:fr.paidBadDebt,total:fr.paidTotal};
        row.totalDue={principal:fr.duePrincipal,interest:fr.dueInterest,fee:fr.dueFee,penalty:fr.duePenalty,unlockFee:0,discount:0,overpaid:0,badDebt:0,total:fr.dueTotal};
      }
      continue;
    }
    if(!monthMap.has(fr.approveMonth))monthMap.set(fr.approveMonth,{approveMonth:fr.approveMonth,buckets:{},totalCount:0,totalPaid:emptyMoney(),totalDue:emptyMoney()});
    const row=monthMap.get(fr.approveMonth)!;
    row.buckets[fr.bucket]={contractCount:fr.contractCount,paid:{principal:fr.paidPrincipal,interest:fr.paidInterest,fee:fr.paidFee,penalty:fr.paidPenalty,unlockFee:fr.paidUnlockFee,discount:fr.paidDiscount,overpaid:fr.paidOverpaid,badDebt:fr.paidBadDebt,total:fr.paidTotal},due:{principal:fr.duePrincipal,interest:fr.dueInterest,fee:fr.dueFee,penalty:fr.duePenalty,unlockFee:0,discount:0,overpaid:0,badDebt:0,total:fr.dueTotal}};
  }
  return Array.from(monthMap.values()).sort((a,b)=>b.approveMonth.localeCompare(a.approveMonth));
}

// ─── Badge items ──────────────────────────────────────────────────────────────
const PAID_BADGE_ITEMS: Array<{key:PaidBadgeKey;label:string;icon:React.ReactNode;canToggle:boolean}> = [
  { key:"principal", label:"เงินต้น",      icon:<Banknote   className="w-3.5 h-3.5"/>, canToggle:true  },
  { key:"interest",  label:"ดอกเบี้ย",     icon:<Percent    className="w-3.5 h-3.5"/>, canToggle:true  },
  { key:"fee",       label:"ค่าดำเนินการ", icon:<Coins      className="w-3.5 h-3.5"/>, canToggle:true  },
  { key:"penalty",   label:"ค่าปรับ",      icon:<Gavel      className="w-3.5 h-3.5"/>, canToggle:true  },
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
  return (v.principal?m.principal:0)+(v.interest?m.interest:0)+(v.fee?m.fee:0)+(v.penalty?m.penalty:0)+(v.overpaid?m.overpaid:0);
}
function computeDueTotal(m:MoneyBreakdown, v:Record<DueBadgeKey,boolean>):number {
  return (v.principal?m.principal:0)+(v.interest?m.interest:0)+(v.fee?m.fee:0)+(v.penalty?m.penalty:0);
}
function addMoney(a:MoneyBreakdown, b:MoneyBreakdown):MoneyBreakdown {
  return {
    principal:a.principal+b.principal, interest:a.interest+b.interest, fee:a.fee+b.fee,
    penalty:a.penalty+b.penalty, unlockFee:a.unlockFee+b.unlockFee, discount:a.discount+b.discount,
    overpaid:a.overpaid+b.overpaid, badDebt:a.badDebt+b.badDebt, total:a.total+b.total,
  };
}
function emptyMoney():MoneyBreakdown {
  return {principal:0,interest:0,fee:0,penalty:0,unlockFee:0,discount:0,overpaid:0,badDebt:0,total:0};
}

function bucketPillClasses(b:string):string {
  const m:Record<string,string>={
    "ปกติ":"bg-green-100 text-green-800 border-green-300","เกิน 1-7":"bg-yellow-100 text-yellow-800 border-yellow-300",
    "เกิน 8-14":"bg-amber-100 text-amber-800 border-amber-300","เกิน 15-30":"bg-orange-100 text-orange-800 border-orange-300",
    "เกิน 31-60":"bg-red-200 text-red-800 border-red-400","เกิน 61-90":"bg-red-300 text-red-900 border-red-500",
    "เกิน >90":"bg-rose-700 text-white border-rose-800","ระงับสัญญา":"bg-gray-800 text-white border-gray-900",
    "สิ้นสุดสัญญา":"bg-blue-100 text-blue-800 border-blue-300","หนี้เสีย":"bg-gray-700 text-white border-gray-800",
  };
  return m[b]??"bg-gray-100 text-gray-700 border-gray-200";
}
function bucketHeaderBg(b:string):string {
  const m:Record<string,string>={
    "ปกติ":"bg-green-700","เกิน 1-7":"bg-yellow-600","เกิน 8-14":"bg-amber-600","เกิน 15-30":"bg-orange-600",
    "เกิน 31-60":"bg-red-600","เกิน 61-90":"bg-red-700","เกิน >90":"bg-rose-800","ระงับสัญญา":"bg-gray-700",
    "สิ้นสุดสัญญา":"bg-blue-700","หนี้เสีย":"bg-gray-800",
  };
  return m[b]??"bg-slate-600";
}
function bucketCellBg(b:string):string {
  const m:Record<string,string>={
    "ปกติ":"bg-green-50/40","เกิน 1-7":"bg-yellow-50/40","เกิน 8-14":"bg-amber-50/40","เกิน 15-30":"bg-orange-50/40",
    "เกิน 31-60":"bg-red-50/40","เกิน 61-90":"bg-red-100/40","เกิน >90":"bg-rose-100/40","ระงับสัญญา":"bg-gray-100/40",
    "สิ้นสุดสัญญา":"bg-blue-50/40","หนี้เสีย":"bg-gray-200/40",
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

function DateRangeFilter({label,dateFrom,setDateFrom,dateTo,setDateTo,monthYear,setMonthYear,accentColor="blue"}:{
  label:string;dateFrom:string;setDateFrom:(v:string)=>void;dateTo:string;setDateTo:(v:string)=>void;
  monthYear:string;setMonthYear:(v:string)=>void;accentColor?:"green"|"orange"|"blue";
}) {
  const ring=accentColor==="green"?"focus:ring-green-500":accentColor==="orange"?"focus:ring-orange-500":"focus:ring-blue-500";
  const hasDate=dateFrom||dateTo;const hasMonth=!!monthYear;
  return(
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-gray-500 whitespace-nowrap">{label}:</span>
      <div className="relative flex items-center">
        <CalendarDays className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none"/>
        <input type="date" value={dateFrom} onChange={(e)=>{setDateFrom(e.target.value);if(e.target.value)setMonthYear("");}}
          className={`h-9 pl-8 pr-2 rounded-md border border-gray-200 bg-white text-sm text-gray-700 focus:outline-none focus:ring-2 ${ring} w-[155px]`}/>
      </div>
      <span className="text-xs text-gray-400">—</span>
      <div className="relative flex items-center">
        <CalendarDays className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none"/>
        <input type="date" value={dateTo} onChange={(e)=>{setDateTo(e.target.value);if(e.target.value)setMonthYear("");}}
          className={`h-9 pl-8 pr-2 rounded-md border border-gray-200 bg-white text-sm text-gray-700 focus:outline-none focus:ring-2 ${ring} w-[155px]`}/>
      </div>
      {hasDate&&(<button type="button" onClick={()=>{setDateFrom("");setDateTo("");}} className="flex items-center justify-center w-6 h-6 rounded-full bg-gray-100 hover:bg-red-100 text-gray-400 hover:text-red-500 transition-colors"><X className="w-3.5 h-3.5"/></button>)}
      <span className="text-xs text-gray-400">หรือ</span>
      <div className="relative flex items-center">
        <input type="month" value={monthYear} onChange={(e)=>{setMonthYear(e.target.value);if(e.target.value){setDateFrom("");setDateTo("");}}}
          className={`h-9 px-3 rounded-md border ${hasMonth?"border-indigo-400 bg-indigo-50 text-indigo-800":"border-gray-200 bg-white text-gray-700"} text-sm focus:outline-none focus:ring-2 ${ring} w-[145px]`}/>
        {hasMonth&&(<button type="button" onClick={()=>setMonthYear("")} className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center justify-center w-5 h-5 rounded-full bg-indigo-100 hover:bg-red-100 text-indigo-400 hover:text-red-500 transition-colors"><X className="w-3 h-3"/></button>)}
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function MonthlySummary() {
  const{can}=useAppAuth();const{section}=useSection();const{setActions}=useNavActions();
  const canView=can("debt_report","view");const canExport=can("debt_report","export");
  const[tab,setTab]=useState<TabKey>("count");

  // per-tab filter state
  const[countProductType,setCountProductType]=useState<Set<string>>(new Set());
  const[paidDateFrom,setPaidDateFrom]=useState("");const[paidDateTo,setPaidDateTo]=useState("");
  const[paidMonthYear,setPaidMonthYear]=useState("");const[paidProductType,setPaidProductType]=useState<Set<string>>(new Set());
  const[dueDateFrom,setDueDateFrom]=useState("");const[dueDateTo,setDueDateTo]=useState("");
  const[dueMonthYear,setDueMonthYear]=useState("");const[dueProductType,setDueProductType]=useState<Set<string>>(new Set());
  const[filterOpen,setFilterOpen]=useState(true);

  // badge visibility (eye toggle ใน badge — มีผลต่อยอดรวมใน badge และตาราง)
  const[paidVis,setPaidVis]=useState<Record<PaidBadgeKey,boolean>>({principal:true,interest:true,fee:true,penalty:true,discount:false,overpaid:true});
  const[dueVis,setDueVis]=useState<Record<DueBadgeKey,boolean>>({principal:true,interest:true,fee:true,penalty:true});

  // bucket eye toggle — แสดง 0 แทนซ่อนคอลัมน์
  const[hiddenBuckets,setHiddenBuckets]=useState<Set<string>>(new Set());
  const toggleBucket=useCallback((b:string)=>{setHiddenBuckets((p)=>{const n=new Set(p);if(n.has(b))n.delete(b);else n.add(b);return n;});},[]);
  const toggleGroup=useCallback((g:ColGroup)=>{setHiddenBuckets((p)=>{const n=new Set(p);const allH=g.buckets.every((b)=>n.has(b));if(allH)g.buckets.forEach((b)=>n.delete(b));else g.buckets.forEach((b)=>n.add(b));return n;});},[]);

  const queryInput=useMemo(()=>{
    if(!section)return null;
    return{section,
      countProductType:countProductType.size===1?Array.from(countProductType)[0]:undefined,
      paidAtFrom:paidDateFrom||undefined,paidAtTo:paidDateTo||undefined,paidAtMonth:paidMonthYear||undefined,
      paidProductType:paidProductType.size===1?Array.from(paidProductType)[0]:undefined,
      dueAtFrom:dueDateFrom||undefined,dueAtTo:dueDateTo||undefined,dueAtMonth:dueMonthYear||undefined,
      dueProductType:dueProductType.size===1?Array.from(dueProductType)[0]:undefined,
    };
  },[section,countProductType,paidDateFrom,paidDateTo,paidMonthYear,paidProductType,dueDateFrom,dueDateTo,dueMonthYear,dueProductType]);

  const query=trpc.monthlySummary.get.useQuery(queryInput as any,{enabled:canView&&!!queryInput});

  // consume rowsJson (JSON string) จาก router — bypass superjson depth limit
  const rowsJson:string=(query.data?.rowsJson??"[]") as string;
  const productTypes:string[]=(query.data?.productTypes??[]) as string[];
  const rows:SummaryRow[]=useMemo(()=>{
    try{const flat:FlatRow[]=JSON.parse(rowsJson);return groupFlatRows(flat);}catch{return[];}
  },[rowsJson]);

  // grand total คำนวณจากทุก bucket (ไม่กรองตาม hidden — badge แสดงยอดจริงทั้งหมด)
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

  // badge totals — รวมจากทุก bucket (ไม่ขึ้นกับ hiddenBuckets)
  const grandBadgePaid=useMemo(()=>{let r=emptyMoney();for(const b of DEBT_BUCKETS){const bt=grandTotal.bucketTotals[b];if(bt)r=addMoney(r,bt.paid);}return r;},[grandTotal]);
  const grandBadgeDue=useMemo(()=>{let r=emptyMoney();for(const b of DEBT_BUCKETS){const bt=grandTotal.bucketTotals[b];if(bt)r=addMoney(r,bt.due);}return r;},[grandTotal]);

  const countFilterCount=countProductType.size>0?1:0;
  const paidFilterCount=[paidDateFrom||paidDateTo,paidMonthYear,paidProductType.size>0].filter(Boolean).length;
  const dueFilterCount=[dueDateFrom||dueDateTo,dueMonthYear,dueProductType.size>0].filter(Boolean).length;
  const activeFilterCount=tab==="count"?countFilterCount:tab==="paid"?paidFilterCount:dueFilterCount;

  const handleExport=useCallback(()=>{
    if(!canExport){toast.error("คุณไม่มีสิทธิ์ Export");return;}
    try{
      const wb=XLSX.utils.book_new();
      const headers=["เดือน-ปีที่อนุมัติ","รวม",...DEBT_BUCKETS];
      const wsData:(string|number)[][]=[headers];
      for(const row of rows)wsData.push([fmtMonthYear(row.approveMonth),row.totalCount,...DEBT_BUCKETS.map((b)=>row.buckets[b]?.contractCount??0)]);
      const ws=XLSX.utils.aoa_to_sheet(wsData);
      XLSX.utils.book_append_sheet(wb,ws,"สรุปรายเดือน");
      XLSX.writeFile(wb,`monthly_summary_${new Date().toISOString().slice(0,10)}.xlsx`);
      toast.success("Export สำเร็จ");
    }catch{toast.error("Export ล้มเหลว");}
  },[canExport,rows]);

  // ใช้ ref เพื่อหลีกเลี่ยง infinite loop ใน useEffect
  const refetchRef=useRef(query.refetch);
  const handleExportRef=useRef(handleExport);
  const isFetchingRef=useRef(query.isFetching);
  const canExportRef=useRef(canExport);
  refetchRef.current=query.refetch;
  handleExportRef.current=handleExport;
  isFetchingRef.current=query.isFetching;
  canExportRef.current=canExport;

  useEffect(()=>{
    setActions(
      <div className="flex items-center gap-1.5">
        <Button variant="outline" size="sm" onClick={()=>refetchRef.current()} className="h-8 px-2.5 text-xs"><RefreshCw className="w-3.5 h-3.5 mr-1"/><span className="hidden sm:inline">รีเฟรช</span></Button>
        {canExportRef.current&&<Button variant="outline" size="sm" onClick={()=>handleExportRef.current()} className="h-8 px-2.5 text-xs"><Download className="w-3.5 h-3.5 mr-1"/><span className="hidden sm:inline">Export</span></Button>}
      </div>
    );
    return()=>setActions(null);
  },[setActions]);

  return(
    <AppShell>
      <div className="flex flex-col h-full min-h-0">
        <SyncStatusBar/>
        {/* Tab switcher */}
        <div className="bg-white border-b border-gray-200 px-4 flex items-center gap-0">
          {(["count","paid","due"]as TabKey[]).map((t)=>{
            const labels:Record<TabKey,string>={count:"จำนวนสัญญา",paid:"ยอดชำระแล้ว",due:"ยอดค้างชำระ"};
            const ac:Record<TabKey,string>={count:"border-slate-600 text-slate-700",paid:"border-green-600 text-green-700",due:"border-orange-600 text-orange-700"};
            const fc:Record<TabKey,number>={count:countFilterCount,paid:paidFilterCount,due:dueFilterCount};
            return(<button key={t} type="button" onClick={()=>setTab(t)} className={["relative px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap",tab===t?ac[t]:"border-transparent text-gray-400 hover:text-gray-600"].join(" ")}>{labels[t]}{fc[t]>0&&<span className="ml-1 inline-flex items-center justify-center bg-blue-500 text-white rounded-full w-4 h-4 text-[10px] font-bold">{fc[t]}</span>}</button>);
          })}
        </div>
        {/* Filter bar */}
        <div className="bg-white border-b border-gray-200 shadow-sm">
          <button type="button" className="w-full flex items-center justify-between px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors" onClick={()=>setFilterOpen((v)=>!v)}>
            <span className="flex items-center gap-1.5"><CalendarDays className="w-4 h-4 text-blue-500"/>ตัวกรอง{activeFilterCount>0&&<span className="ml-1 inline-flex items-center justify-center bg-blue-500 text-white rounded-full w-4 h-4 text-[10px] font-bold">{activeFilterCount}</span>}</span>
            <span className="text-xs text-gray-400">{filterOpen?"▲ ซ่อน":"▼ แสดง"}</span>
          </button>
          {filterOpen&&(
            <div className="px-4 pb-3 pt-1 flex flex-wrap items-center gap-2">
              {tab==="count"&&(<><MultiSelectFilter label="ประเภทสินค้า" selected={countProductType} onChange={setCountProductType} options={productTypes} placeholder="ทุกประเภทสินค้า"/>{countProductType.size>0&&<button type="button" onClick={()=>setCountProductType(new Set())} className="flex items-center gap-1 h-9 px-2.5 rounded-md border border-red-200 bg-red-50 text-red-600 text-xs hover:bg-red-100 transition-colors"><X className="w-3.5 h-3.5"/>ล้างทั้งหมด</button>}</>)}
              {tab==="paid"&&(<><DateRangeFilter label="วันที่ชำระ" dateFrom={paidDateFrom} setDateFrom={setPaidDateFrom} dateTo={paidDateTo} setDateTo={setPaidDateTo} monthYear={paidMonthYear} setMonthYear={setPaidMonthYear} accentColor="green"/><MultiSelectFilter label="ประเภทสินค้า" selected={paidProductType} onChange={setPaidProductType} options={productTypes} placeholder="ทุกประเภทสินค้า"/>{paidFilterCount>0&&<button type="button" onClick={()=>{setPaidDateFrom("");setPaidDateTo("");setPaidMonthYear("");setPaidProductType(new Set());}} className="flex items-center gap-1 h-9 px-2.5 rounded-md border border-red-200 bg-red-50 text-red-600 text-xs hover:bg-red-100 transition-colors"><X className="w-3.5 h-3.5"/>ล้างทั้งหมด</button>}</>)}
              {tab==="due"&&(<><DateRangeFilter label="วันที่ต้องชำระ" dateFrom={dueDateFrom} setDateFrom={setDueDateFrom} dateTo={dueDateTo} setDateTo={setDueDateTo} monthYear={dueMonthYear} setMonthYear={setDueMonthYear} accentColor="orange"/><MultiSelectFilter label="ประเภทเครื่อง" selected={dueProductType} onChange={setDueProductType} options={productTypes} placeholder="ทุกประเภทเครื่อง"/>{dueFilterCount>0&&<button type="button" onClick={()=>{setDueDateFrom("");setDueDateTo("");setDueMonthYear("");setDueProductType(new Set());}} className="flex items-center gap-1 h-9 px-2.5 rounded-md border border-red-200 bg-red-50 text-red-600 text-xs hover:bg-red-100 transition-colors"><X className="w-3.5 h-3.5"/>ล้างทั้งหมด</button>}</>)}
            </div>
          )}
        </div>
        {/* Badge: paid */}
        {tab==="paid"&&(
          <div className="bg-green-50/60 border-b border-green-200 px-4 py-2 flex flex-wrap items-center gap-2">
            {PAID_BADGE_ITEMS.map(({key,label,icon,canToggle})=>{const isOn=paidVis[key];const val=grandBadgePaid[key as keyof MoneyBreakdown];return(
              <button key={key} type="button" onClick={()=>{if(!canToggle)return;setPaidVis((p)=>({...p,[key]:!p[key]}));}} title={canToggle?(isOn?`ซ่อน${label}`:`แสดง${label}`):`${label} (ปิดเสมอ)`}
                className={["flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border transition-colors",!canToggle?"opacity-40 cursor-not-allowed bg-gray-100 border-gray-200 text-gray-400":isOn?"bg-green-100 border-green-300 text-green-800 hover:bg-green-200":"bg-gray-100 border-gray-200 text-gray-400 hover:bg-gray-200"].join(" ")}>
                {isOn?<Eye className="w-3 h-3"/>:<EyeOff className="w-3 h-3"/>}{icon}<span>{label}</span>{isOn&&<span className="font-semibold ml-0.5">{fmtMoney(val)}</span>}
              </button>
            );})}
            <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border bg-green-700 border-green-800 text-white font-semibold"><Banknote className="w-3.5 h-3.5"/><span>รวมยอดชำระ</span><span>{fmtMoney(computePaidTotal(grandBadgePaid,paidVis))}</span></div>
          </div>
        )}
        {/* Badge: due */}
        {tab==="due"&&(
          <div className="bg-orange-50/60 border-b border-orange-200 px-4 py-2 flex flex-wrap items-center gap-2">
            {DUE_BADGE_ITEMS.map(({key,label,icon,canToggle})=>{const isOn=dueVis[key];const val=grandBadgeDue[key as keyof MoneyBreakdown];return(
              <button key={key} type="button" onClick={()=>{if(!canToggle)return;setDueVis((p)=>({...p,[key]:!p[key]}));}} title={isOn?`ซ่อน${label}`:`แสดง${label}`}
                className={["flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border transition-colors",isOn?"bg-orange-100 border-orange-300 text-orange-800 hover:bg-orange-200":"bg-gray-100 border-gray-200 text-gray-400 hover:bg-gray-200"].join(" ")}>
                {isOn?<Eye className="w-3 h-3"/>:<EyeOff className="w-3 h-3"/>}{icon}<span>{label}</span>{isOn&&<span className="font-semibold ml-0.5">{fmtMoney(val)}</span>}
              </button>
            );})}
            <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border bg-orange-700 border-orange-800 text-white font-semibold"><Banknote className="w-3.5 h-3.5"/><span>รวมยอดค้างชำระ</span><span>{fmtMoney(computeDueTotal(grandBadgeDue,dueVis))}</span></div>
          </div>
        )}
        {/* Table */}
        <div className="flex-1 min-h-0 overflow-auto">
          {!canView?(<div className="flex items-center justify-center h-full text-gray-400 text-sm">คุณไม่มีสิทธิ์ดูข้อมูลนี้</div>)
          :query.isLoading?(<div className="flex items-center justify-center h-full gap-2 text-gray-400"><Spinner className="w-5 h-5"/><span className="text-sm">กำลังโหลด...</span></div>)
          :query.error?(<div className="flex flex-col items-center justify-center h-full gap-3 text-red-500"><span className="text-sm">โหลดข้อมูลล้มเหลว: {query.error.message}</span><Button variant="outline" size="sm" onClick={()=>query.refetch()}><RefreshCw className="w-4 h-4 mr-1"/>ลองใหม่</Button></div>)
          :rows.length===0?(<div className="flex items-center justify-center h-full text-gray-400 text-sm">ไม่มีข้อมูล</div>)
          :(<SummaryTable tab={tab} rows={rows} grandTotal={grandTotal} hiddenBuckets={hiddenBuckets} toggleBucket={toggleBucket} toggleGroup={toggleGroup} paidVis={paidVis} dueVis={dueVis}/>)}
        </div>
      </div>
    </AppShell>
  );
}

// ─── SummaryTable ─────────────────────────────────────────────────────────────
function SummaryTable({tab,rows,grandTotal,hiddenBuckets,toggleBucket,toggleGroup,paidVis,dueVis}:{
  tab:TabKey;rows:SummaryRow[];grandTotal:GrandTotal;hiddenBuckets:Set<string>;
  toggleBucket:(b:string)=>void;toggleGroup:(g:ColGroup)=>void;
  paidVis:Record<PaidBadgeKey,boolean>;dueVis:Record<DueBadgeKey,boolean>;
}) {
  // paid tab: "หนี้เสีย" แยกเป็น 2 คอลัมน์
  const isPaidBadDebt=(b:string)=>tab==="paid"&&b==="หนี้เสีย";
  const bucketColSpan=(b:string)=>isPaidBadDebt(b)?2:1;

  // helper: คำนวณค่าในเซลล์ — ถ้า hidden ให้ return 0
  const cellCountVal=(b:string,cell:SummaryCell|undefined)=>hiddenBuckets.has(b)?0:(cell?.contractCount??0);
  const cellPaidVal=(b:string,cell:SummaryCell|undefined)=>hiddenBuckets.has(b)?0:(cell?computePaidTotal(cell.paid,paidVis):0);
  const cellPaidBadDebtVal=(b:string,cell:SummaryCell|undefined)=>hiddenBuckets.has(b)?0:(cell?.paid.badDebt??0);
  const cellDueVal=(b:string,cell:SummaryCell|undefined)=>hiddenBuckets.has(b)?0:(cell?computeDueTotal(cell.due,dueVis):0);

  // grand total cell helpers
  const gtCountVal=(b:string)=>{const bt=grandTotal.bucketTotals[b];return hiddenBuckets.has(b)?0:(bt?.count??0);};
  const gtPaidVal=(b:string)=>{const bt=grandTotal.bucketTotals[b];return hiddenBuckets.has(b)?0:(bt?computePaidTotal(bt.paid,paidVis):0);};
  const gtPaidBadDebtVal=(b:string)=>{const bt=grandTotal.bucketTotals[b];return hiddenBuckets.has(b)?0:(bt?.paid.badDebt??0);};
  const gtDueVal=(b:string)=>{const bt=grandTotal.bucketTotals[b];return hiddenBuckets.has(b)?0:(bt?computeDueTotal(bt.due,dueVis):0);};

  // คำนวณ minWidth: 130(เดือน) + 90(รวม) + buckets + 2 subtotal cols + 130(รวมทั้งหมด)
  const minWidth=useMemo(()=>{
    let w=130+90;
    for(const b of DEBT_BUCKETS)w+=isPaidBadDebt(b)?240:120;
    // +2 subtotal columns (รวมปกติ + รวมสงสัย)
    w+=120*2+130;
    return w;
  },[tab]);// eslint-disable-line react-hooks/exhaustive-deps

  // คำนวณ subtotal ปกติ และ สงสัย ต่อ row
  const normalBuckets=COL_GROUPS[0].buckets as readonly string[];
  const suspectBuckets=COL_GROUPS[1].buckets as readonly string[];

  function rowNormalCount(row:SummaryRow):number{return normalBuckets.reduce((s,b)=>s+cellCountVal(b,row.buckets[b]),0);}
  function rowNormalPaid(row:SummaryRow):number{return normalBuckets.reduce((s,b)=>s+cellPaidVal(b,row.buckets[b]),0);}
  function rowNormalDue(row:SummaryRow):number{return normalBuckets.reduce((s,b)=>s+cellDueVal(b,row.buckets[b]),0);}
  function rowSuspectCount(row:SummaryRow):number{return suspectBuckets.reduce((s,b)=>s+cellCountVal(b,row.buckets[b]),0);}
  function rowSuspectPaid(row:SummaryRow):number{return suspectBuckets.reduce((s,b)=>s+cellPaidVal(b,row.buckets[b]),0);}
  function rowSuspectDue(row:SummaryRow):number{return suspectBuckets.reduce((s,b)=>s+cellDueVal(b,row.buckets[b]),0);}

  // grand total subtotals
  const gtNormalCount=normalBuckets.reduce((s,b)=>s+gtCountVal(b),0);
  const gtNormalPaid=normalBuckets.reduce((s,b)=>s+gtPaidVal(b),0);
  const gtNormalDue=normalBuckets.reduce((s,b)=>s+gtDueVal(b),0);
  const gtSuspectCount=suspectBuckets.reduce((s,b)=>s+gtCountVal(b),0);
  const gtSuspectPaid=suspectBuckets.reduce((s,b)=>s+gtPaidVal(b),0);
  const gtSuspectDue=suspectBuckets.reduce((s,b)=>s+gtDueVal(b),0);

  // grand row total
  function rowTotal(row:SummaryRow):number{
    if(tab==="count")return row.totalCount;
    if(tab==="paid")return computePaidTotal(row.totalPaid,paidVis);
    return computeDueTotal(row.totalDue,dueVis);
  }
  const gtTotal=tab==="count"?grandTotal.totalCount:tab==="paid"?computePaidTotal(grandTotal.totalPaid,paidVis):computeDueTotal(grandTotal.totalDue,dueVis);

  // sub-header label
  const subLabel=tab==="count"?"จำนวน":tab==="paid"?"ยอดชำระ":"ยอดค้าง";

  // render cell value
  function renderCount(v:number){return v>0?(<span className="inline-flex items-center justify-center bg-slate-200 text-slate-700 rounded-full px-2.5 py-0.5 text-xs font-bold">{v.toLocaleString()}</span>):(<span className="text-gray-300">—</span>);}
  function renderMoney(v:number,colorClass:string){return<span className={v>0?colorClass:"text-gray-300"}>{v>0?fmtMoney(v):"0.00"}</span>;}

  return(
    <table className="w-full text-sm border-collapse" style={{minWidth:`${minWidth}px`}}>
      <thead className="sticky top-0 z-20">
        {/* Row 1: group headers */}
        <tr>
          <th rowSpan={3} className="sticky left-0 z-30 px-3 py-2 text-left font-semibold whitespace-nowrap bg-slate-800 text-white border-r border-slate-600 min-w-[130px]">เดือน-ปีที่อนุมัติ</th>
          <th rowSpan={3} className="sticky left-[130px] z-30 px-3 py-2 text-right font-semibold whitespace-nowrap bg-slate-700 text-white border-r border-slate-500 min-w-[90px]">รวม</th>
          {COL_GROUPS.map((g,gi)=>{
            // colSpan = buckets + 1 subtotal col (ยกเว้น bad group ไม่มี subtotal)
            const hasSub=gi<2;// normal และ suspect มี subtotal
            const bucketSpan=g.buckets.reduce((a,b)=>a+bucketColSpan(b),0);
            const span=bucketSpan+(hasSub?1:0);
            const allH=g.buckets.every((b)=>hiddenBuckets.has(b));
            return(<th key={g.key} colSpan={span} className={`px-2 py-1.5 text-center text-xs font-bold text-white border-r border-white/20 ${g.headerBg}`}><button type="button" onClick={()=>toggleGroup(g)} className="flex items-center justify-center gap-1.5 mx-auto hover:opacity-80 transition-opacity" title={allH?`แสดง${g.label}`:`ซ่อน${g.label}`}>{allH?<EyeOff className="w-3 h-3"/>:<Eye className="w-3 h-3"/>}{g.label}</button></th>);
          })}
          <th rowSpan={3} className="px-3 py-2 text-right font-semibold whitespace-nowrap text-white bg-slate-800 min-w-[130px]">รวมทั้งหมด</th>
        </tr>
        {/* Row 2: bucket names + subtotal labels */}
        <tr>
          {COL_GROUPS.map((g,gi)=>{
            const hasSub=gi<2;
            const subLabel2=gi===0?"รวม(ปกติ)":"รวม(สงสัย)";
            const subBg=gi===0?"bg-green-800":"bg-orange-800";
            return(<React.Fragment key={g.key}>
              {g.buckets.map((b)=>(
                <th key={b} colSpan={bucketColSpan(b)} className={`px-2 py-1.5 text-center text-xs font-semibold text-white whitespace-nowrap min-w-[120px] border-r border-white/10 ${bucketHeaderBg(b)}`}>
                  <div className="flex items-center justify-center gap-1">
                    <button type="button" onClick={()=>toggleBucket(b)} className="hover:opacity-80 transition-opacity" title={hiddenBuckets.has(b)?`แสดง${b}`:`ซ่อน${b}`}>{hiddenBuckets.has(b)?<EyeOff className="w-3 h-3"/>:<Eye className="w-3 h-3"/>}</button>
                    <span className={`inline-block px-1.5 py-0.5 rounded-full text-[10px] border ${bucketPillClasses(b)}`}>{b}</span>
                  </div>
                </th>
              ))}
              {hasSub&&<th rowSpan={2} className={`px-2 py-1.5 text-center text-xs font-bold text-white whitespace-nowrap min-w-[120px] border-r border-white/20 ${subBg}`}>{subLabel2}</th>}
            </React.Fragment>);
          })}
        </tr>
        {/* Row 3: sub-label per bucket */}
        <tr>
          {COL_GROUPS.map((g)=>(
            <React.Fragment key={g.key}>
              {g.buckets.map((b)=>{
                if(isPaidBadDebt(b))return(<React.Fragment key={b}><th className={`px-2 py-1 text-center text-[10px] font-medium text-white/90 whitespace-nowrap border-r border-white/10 ${bucketHeaderBg(b)}`}>ยอดชำระ</th><th className={`px-2 py-1 text-center text-[10px] font-medium text-red-200 whitespace-nowrap border-r border-white/10 ${bucketHeaderBg(b)}`}>หนี้เสีย</th></React.Fragment>);
                return<th key={b} className={`px-2 py-1 text-center text-[10px] font-medium text-white/80 whitespace-nowrap border-r border-white/10 ${bucketHeaderBg(b)}`}>{subLabel}</th>;
              })}
            </React.Fragment>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-100">
        {rows.map((row)=>(
          <tr key={row.approveMonth} className="hover:bg-blue-50/30 transition-colors">
            <td className="sticky left-0 z-10 px-3 py-2.5 font-medium text-slate-800 whitespace-nowrap border-r border-gray-200 bg-white">{fmtMonthYear(row.approveMonth)}</td>
            <td className="sticky left-[130px] z-10 px-3 py-2.5 text-right border-r border-gray-200 bg-white">
              {tab==="count"?renderCount(row.totalCount):tab==="paid"?renderMoney(computePaidTotal(row.totalPaid,paidVis),"text-green-800 font-medium"):renderMoney(computeDueTotal(row.totalDue,dueVis),"text-orange-800 font-medium")}
            </td>
            {COL_GROUPS.map((g,gi)=>{
              const hasSub=gi<2;
              return(<React.Fragment key={g.key}>
                {g.buckets.map((b)=>{
                  const cell=row.buckets[b];const cellBg=bucketCellBg(b);
                  if(tab==="count"){const v=cellCountVal(b,cell);return<td key={b} className={`px-3 py-2.5 text-right ${cellBg}`}>{renderCount(v)}</td>;}
                  if(tab==="paid"){
                    if(isPaidBadDebt(b)){const pv=cellPaidVal(b,cell);const bv=cellPaidBadDebtVal(b,cell);return(<React.Fragment key={b}><td className={`px-3 py-2.5 text-right ${cellBg}`}>{renderMoney(pv,"text-green-800 font-medium")}</td><td className={`px-3 py-2.5 text-right ${cellBg}`}>{renderMoney(bv,"text-red-700 font-medium")}</td></React.Fragment>);}
                    const v=cellPaidVal(b,cell);return<td key={b} className={`px-3 py-2.5 text-right ${cellBg}`}>{renderMoney(v,"text-green-800 font-medium")}</td>;
                  }
                  const v=cellDueVal(b,cell);return<td key={b} className={`px-3 py-2.5 text-right ${cellBg}`}>{renderMoney(v,"text-orange-800 font-medium")}</td>;
                })}
                {hasSub&&(()=>{
                  const subBg=gi===0?"bg-green-50/60":"bg-orange-50/60";
                  if(tab==="count"){const v=gi===0?rowNormalCount(row):rowSuspectCount(row);return<td className={`px-3 py-2.5 text-right font-bold ${subBg} border-r border-gray-200`}>{renderCount(v)}</td>;}
                  if(tab==="paid"){const v=gi===0?rowNormalPaid(row):rowSuspectPaid(row);return<td className={`px-3 py-2.5 text-right font-bold ${subBg} border-r border-gray-200`}>{renderMoney(v,"text-green-900")}</td>;}
                  const v=gi===0?rowNormalDue(row):rowSuspectDue(row);return<td className={`px-3 py-2.5 text-right font-bold ${subBg} border-r border-gray-200`}>{renderMoney(v,"text-orange-900")}</td>;
                })()}
              </React.Fragment>);
            })}
            <td className="px-3 py-2.5 text-right font-bold bg-slate-50">
              {tab==="count"?renderCount(row.totalCount):tab==="paid"?renderMoney(rowTotal(row),"text-green-900"):renderMoney(rowTotal(row),"text-orange-900")}
            </td>
          </tr>
        ))}
        {/* Grand total row */}
        <tr className="border-t-2 border-slate-400 bg-slate-100 font-bold sticky bottom-0 z-10">
          <td className="sticky left-0 z-20 px-3 py-2.5 text-slate-800 whitespace-nowrap border-r border-slate-300 bg-slate-200">รวมทั้งหมด</td>
          <td className="sticky left-[130px] z-20 px-3 py-2.5 text-right border-r border-slate-300 bg-slate-200">
            {tab==="count"?(<span className="inline-flex items-center justify-center bg-slate-400 text-white rounded-full px-2.5 py-0.5 text-xs font-bold">{grandTotal.totalCount.toLocaleString()}</span>):tab==="paid"?renderMoney(computePaidTotal(grandTotal.totalPaid,paidVis),"text-green-900"):renderMoney(computeDueTotal(grandTotal.totalDue,dueVis),"text-orange-900")}
          </td>
          {COL_GROUPS.map((g,gi)=>{
            const hasSub=gi<2;
            return(<React.Fragment key={g.key}>
              {g.buckets.map((b)=>{
                const cellBg=bucketCellBg(b);
                if(tab==="count"){const v=gtCountVal(b);return<td key={b} className={`px-3 py-2.5 text-right ${cellBg}`}><span className="inline-flex items-center justify-center bg-slate-200 text-slate-800 rounded-full px-2.5 py-0.5 text-xs font-bold">{v.toLocaleString()}</span></td>;}
                if(tab==="paid"){
                  if(isPaidBadDebt(b)){const pv=gtPaidVal(b);const bv=gtPaidBadDebtVal(b);return(<React.Fragment key={b}><td className={`px-3 py-2.5 text-right ${cellBg}`}>{renderMoney(pv,"text-green-900")}</td><td className={`px-3 py-2.5 text-right ${cellBg}`}>{renderMoney(bv,"text-red-700")}</td></React.Fragment>);}
                  const v=gtPaidVal(b);return<td key={b} className={`px-3 py-2.5 text-right ${cellBg}`}>{renderMoney(v,"text-green-900")}</td>;
                }
                const v=gtDueVal(b);return<td key={b} className={`px-3 py-2.5 text-right ${cellBg}`}>{renderMoney(v,"text-orange-900")}</td>;
              })}
              {hasSub&&(()=>{
                const subBg=gi===0?"bg-green-100":"bg-orange-100";
                if(tab==="count"){const v=gi===0?gtNormalCount:gtSuspectCount;return<td className={`px-3 py-2.5 text-right font-bold ${subBg} border-r border-slate-300`}><span className="inline-flex items-center justify-center bg-slate-300 text-slate-800 rounded-full px-2.5 py-0.5 text-xs font-bold">{v.toLocaleString()}</span></td>;}
                if(tab==="paid"){const v=gi===0?gtNormalPaid:gtSuspectPaid;return<td className={`px-3 py-2.5 text-right font-bold ${subBg} border-r border-slate-300`}>{renderMoney(v,"text-green-900")}</td>;}
                const v=gi===0?gtNormalDue:gtSuspectDue;return<td className={`px-3 py-2.5 text-right font-bold ${subBg} border-r border-slate-300`}>{renderMoney(v,"text-orange-900")}</td>;
              })()}
            </React.Fragment>);
          })}
          <td className="px-3 py-2.5 text-right font-bold bg-slate-200">
            {tab==="count"?(<span className="inline-flex items-center justify-center bg-slate-500 text-white rounded-full px-2.5 py-0.5 text-xs font-bold">{grandTotal.totalCount.toLocaleString()}</span>):tab==="paid"?renderMoney(gtTotal,"text-green-900"):renderMoney(gtTotal,"text-orange-900")}
          </td>
        </tr>
      </tbody>
    </table>
  );
}

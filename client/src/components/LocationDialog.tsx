/**
 * LocationDialog — Phase 150
 *
 * Dialog แสดงประวัติ GPS location ที่ดึงมาได้จาก device_location_logs
 * ใช้ร่วมกันใน 3 หน้า: Contracts, WatchGroup, SuspectedBadDebt
 *
 * Flow:
 *   1. ผู้ใช้กดปุ่ม MapPin (สีเขียว = มี log, สีเทา = ไม่มี log / กดไม่ได้)
 *   2. Dialog เปิดขึ้น + เรียก trpc.mdm.getLocationLogs
 *   3. แสดงตาราง 5 คอลัมน์: วันที่ | เวลา | ละติจูด | ลองติจูด | ไอคอน Google Maps
 *   4. เรียงลำดับจากใหม่สุดไปเก่า
 */
import React, { useState } from "react";
import { MapPin, ExternalLink, Loader2, History } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc";
import type { SectionKey } from "../../../shared/const";

/* ─── Props ─────────────────────────────────────────────────────────────── */
interface LocationDialogProps {
  open: boolean;
  onClose: () => void;
  section: SectionKey;
  /** MDM internal ID — ต้องมีเพื่อ query logs */
  mdmDeviceId: number | null;
  /** ชื่อลูกค้า — แสดงใน title */
  customerName?: string | null;
  /** เลขที่สัญญา — แสดงใน title */
  contractNo?: string | null;
  /** Serial Number — ใช้ query logs */
  serialNo?: string | null;
}

/* ─── Helper: แยกวันที่และเวลาจาก timestamp ─────────────────────────────── */
function splitDateTime(ts: Date | string): { date: string; time: string } {
  const d = typeof ts === "string" ? new Date(ts) : ts;
  if (isNaN(d.getTime())) return { date: "–", time: "–" };
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return { date, time };
}

/* ─── Component ─────────────────────────────────────────────────────────── */
export function LocationDialog({
  open,
  onClose,
  section,
  mdmDeviceId,
  customerName,
  contractNo,
  serialNo,
}: LocationDialogProps) {
  // ดึง location logs จาก DB (ไม่ใช่ live GPS)
  const { data: logs, isLoading } = trpc.mdm.getLocationLogs.useQuery(
    { section, serialNo: serialNo ?? "", limit: 50 },
    {
      enabled: open && !!serialNo,
      staleTime: 30_000, // cache 30 วินาที
      retry: false,
    },
  );

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg w-full">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <History className="w-4 h-4 text-teal-600 shrink-0" />
            <span className="truncate">
              ประวัติตำแหน่ง GPS
              {contractNo ? ` — ${contractNo}` : ""}
            </span>
          </DialogTitle>
        </DialogHeader>

        {/* ข้อมูลอุปกรณ์ */}
        <div className="text-xs text-gray-500 space-y-0.5 -mt-1">
          {customerName && (
            <p>
              <span className="font-medium text-gray-700">{customerName}</span>
            </p>
          )}
          {serialNo && (
            <p>
              SN: <span className="font-mono text-gray-600">{serialNo}</span>
            </p>
          )}
        </div>

        {/* ─── Loading ─── */}
        {isLoading && (
          <div className="flex flex-col items-center justify-center py-8 gap-3">
            <Loader2 className="w-7 h-7 text-teal-500 animate-spin" />
            <p className="text-sm text-gray-500">กำลังโหลดประวัติ...</p>
          </div>
        )}

        {/* ─── ไม่มี serialNo ─── */}
        {!isLoading && !serialNo && (
          <div className="flex flex-col items-center justify-center py-8 gap-2">
            <MapPin className="w-8 h-8 text-gray-300" />
            <p className="text-sm text-gray-400">ไม่พบ Serial Number</p>
          </div>
        )}

        {/* ─── ไม่มี log ─── */}
        {!isLoading && serialNo && logs && logs.length === 0 && (
          <div className="flex flex-col items-center justify-center py-8 gap-2">
            <History className="w-8 h-8 text-gray-300" />
            <p className="text-sm text-gray-500">ยังไม่มีประวัติตำแหน่ง</p>
            <p className="text-xs text-gray-400 text-center leading-relaxed">
              ระบบจะบันทึกตำแหน่งอัตโนมัติเมื่อ Sync MDM
              <br />
              และเครื่องอยู่ใน Lost Mode + ออนไลน์อยู่
            </p>
          </div>
        )}

        {/* ─── ตาราง log ─── */}
        {!isLoading && logs && logs.length > 0 && (
          <div className="overflow-auto max-h-80 rounded-lg border border-gray-200">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 sticky top-0 z-10">
                <tr>
                  <th className="px-3 py-2 text-left font-medium text-gray-600 whitespace-nowrap border-b border-gray-200">
                    วันที่
                  </th>
                  <th className="px-3 py-2 text-left font-medium text-gray-600 whitespace-nowrap border-b border-gray-200">
                    เวลา
                  </th>
                  <th className="px-3 py-2 text-right font-medium text-gray-600 whitespace-nowrap border-b border-gray-200">
                    ละติจูด
                  </th>
                  <th className="px-3 py-2 text-right font-medium text-gray-600 whitespace-nowrap border-b border-gray-200">
                    ลองติจูด
                  </th>
                  <th className="px-3 py-2 text-center font-medium text-gray-600 whitespace-nowrap border-b border-gray-200">
                    แผนที่
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {logs.map((log, idx) => {
                  const { date, time } = splitDateTime(log.recordedAt);
                  const mapsUrl = `https://maps.google.com/?q=${log.latitude},${log.longitude}`;
                  return (
                    <tr
                      key={log.id}
                      className={idx % 2 === 0 ? "bg-white" : "bg-gray-50/50"}
                    >
                      <td className="px-3 py-1.5 font-mono text-gray-700 whitespace-nowrap">
                        {date}
                      </td>
                      <td className="px-3 py-1.5 font-mono text-gray-500 whitespace-nowrap">
                        {time}
                      </td>
                      <td className="px-3 py-1.5 font-mono text-right text-gray-700 whitespace-nowrap">
                        {parseFloat(log.latitude).toFixed(6)}
                      </td>
                      <td className="px-3 py-1.5 font-mono text-right text-gray-700 whitespace-nowrap">
                        {parseFloat(log.longitude).toFixed(6)}
                      </td>
                      <td className="px-3 py-1.5 text-center">
                        <a
                          href={mapsUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="เปิดใน Google Maps"
                          className="inline-flex items-center justify-center w-6 h-6 rounded text-blue-500 hover:text-blue-700 hover:bg-blue-50 transition-colors"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* จำนวน log */}
        {!isLoading && logs && logs.length > 0 && (
          <p className="text-[10px] text-gray-400 text-right -mt-1">
            {logs.length} รายการล่าสุด (เรียงจากใหม่สุด)
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ─── Hook: useLocationDialog ────────────────────────────────────────────── */
/**
 * Hook สำหรับจัดการ state ของ LocationDialog
 * ใช้ใน parent component เพื่อเปิด/ปิด dialog และส่ง props
 */
export function useLocationDialog() {
  const [dialogState, setDialogState] = useState<{
    open: boolean;
    mdmDeviceId: number | null;
    customerName?: string | null;
    contractNo?: string | null;
    serialNo?: string | null;
  }>({
    open: false,
    mdmDeviceId: null,
  });

  const openDialog = (params: {
    mdmDeviceId: number | null;
    customerName?: string | null;
    contractNo?: string | null;
    serialNo?: string | null;
  }) => {
    setDialogState({ open: true, ...params });
  };

  const closeDialog = () => {
    setDialogState((prev) => ({ ...prev, open: false }));
  };

  return { dialogState, openDialog, closeDialog };
}

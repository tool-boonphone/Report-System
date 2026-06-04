/**
 * LocationDialog — Phase 141
 *
 * Dialog แสดงตำแหน่ง GPS ของอุปกรณ์แบบ real-time จาก MDM API
 * ใช้ร่วมกันใน 3 หน้า: Contracts, WatchGroup, SuspectedBadDebt
 *
 * Flow:
 *   1. ผู้ใช้กดปุ่ม MapPin ในแถวที่มี serialNo
 *   2. Dialog เปิดขึ้น + เรียก trpc.mdm.fetchLiveLocation
 *   3. แสดง lat/lng + ปุ่มเปิด Google Maps ใน tab ใหม่
 *   4. ถ้า device offline → แสดงข้อความแจ้งเตือนที่เข้าใจง่าย
 */
import React, { useState } from "react";
import { MapPin, ExternalLink, Loader2, WifiOff, Navigation } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import type { SectionKey } from "../../../shared/const";

/* ─── Props ─────────────────────────────────────────────────────────────── */
interface LocationDialogProps {
  open: boolean;
  onClose: () => void;
  section: SectionKey;
  /** MDM internal ID — ต้องมีเพื่อเรียก GPS API */
  mdmDeviceId: number | null;
  /** ชื่อลูกค้า — แสดงใน title */
  customerName?: string | null;
  /** เลขที่สัญญา — แสดงใน title */
  contractNo?: string | null;
  /** Serial Number — แสดงข้อมูลเพิ่มเติม */
  serialNo?: string | null;
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
  // เรียก fetchLiveLocation เฉพาะเมื่อ dialog เปิดและมี mdmDeviceId
  const { data, isLoading, error } = trpc.mdm.fetchLiveLocation.useQuery(
    { section, mdmDeviceId: mdmDeviceId! },
    {
      enabled: open && !!mdmDeviceId && mdmDeviceId > 0,
      // ไม่ cache — ดึงใหม่ทุกครั้งที่เปิด dialog
      staleTime: 0,
      gcTime: 0,
      retry: false, // ไม่ retry เพราะ device อาจ offline จริงๆ
    },
  );

  // Google Maps URL
  const mapsUrl =
    data?.latitude && data?.longitude
      ? `https://maps.google.com/?q=${data.latitude},${data.longitude}`
      : null;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm w-full">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <MapPin className="w-4 h-4 text-teal-600 shrink-0" />
            <span className="truncate">
              ตำแหน่ง GPS
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
            <Loader2 className="w-8 h-8 text-teal-500 animate-spin" />
            <p className="text-sm text-gray-500">กำลังดึงตำแหน่ง GPS...</p>
            <p className="text-xs text-gray-400">อาจใช้เวลา 3–10 วินาที</p>
          </div>
        )}

        {/* ─── Error / Offline ─── */}
        {!isLoading && (error || data === null) && (
          <div className="flex flex-col items-center justify-center py-8 gap-3">
            <WifiOff className="w-8 h-8 text-gray-400" />
            <p className="text-sm font-medium text-gray-600">
              ไม่สามารถดึงตำแหน่งได้
            </p>
            <p className="text-xs text-gray-400 text-center leading-relaxed">
              อุปกรณ์อาจไม่ได้ออนไลน์อยู่ในขณะนี้
              <br />
              หรือ Location Services ถูกปิดบนเครื่อง
            </p>
          </div>
        )}

        {/* ─── No MDM ID ─── */}
        {!isLoading && !mdmDeviceId && (
          <div className="flex flex-col items-center justify-center py-8 gap-3">
            <MapPin className="w-8 h-8 text-gray-300" />
            <p className="text-sm text-gray-400">
              ไม่พบข้อมูล MDM Device ID
            </p>
            <p className="text-xs text-gray-400 text-center">
              กรุณา Sync MDM ก่อนเพื่อให้ระบบจดจำ Device ID
            </p>
          </div>
        )}

        {/* ─── GPS Data ─── */}
        {!isLoading && data && data.latitude && data.longitude && (
          <div className="space-y-4">
            {/* Coordinates */}
            <div className="bg-teal-50 border border-teal-200 rounded-lg p-3 space-y-2">
              <div className="flex items-center gap-1.5 text-xs font-medium text-teal-700">
                <Navigation className="w-3.5 h-3.5" />
                พิกัด GPS
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <p className="text-[10px] text-gray-400 uppercase tracking-wide">
                    Latitude
                  </p>
                  <p className="text-sm font-mono font-semibold text-gray-800">
                    {parseFloat(data.latitude).toFixed(6)}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] text-gray-400 uppercase tracking-wide">
                    Longitude
                  </p>
                  <p className="text-sm font-mono font-semibold text-gray-800">
                    {parseFloat(data.longitude).toFixed(6)}
                  </p>
                </div>
              </div>
              {/* ข้อมูลเพิ่มเติม */}
              {(data.altitude || data.speed) && (
                <div className="grid grid-cols-2 gap-2 pt-1 border-t border-teal-100">
                  {data.altitude && (
                    <div>
                      <p className="text-[10px] text-gray-400">ความสูง</p>
                      <p className="text-xs text-gray-600">
                        {parseFloat(data.altitude).toFixed(1)} ม.
                      </p>
                    </div>
                  )}
                  {data.speed && (
                    <div>
                      <p className="text-[10px] text-gray-400">ความเร็ว</p>
                      <p className="text-xs text-gray-600">
                        {parseFloat(data.speed).toFixed(1)} กม./ชม.
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* ปุ่มเปิด Google Maps */}
            {mapsUrl && (
              <a
                href={mapsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(
                  "flex items-center justify-center gap-2 w-full py-2.5 px-4",
                  "rounded-lg text-sm font-medium",
                  "bg-blue-600 hover:bg-blue-700 text-white transition-colors",
                )}
              >
                <ExternalLink className="w-4 h-4" />
                เปิดใน Google Maps
              </a>
            )}
          </div>
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

/**
 * StreamLoadingOverlay — Phase 118
 * แสดง progress bar และจำนวนสัญญาที่โหลดแล้ว
 * ใช้ร่วมกันในทุกหน้าที่มีการโหลดข้อมูลสัญญาแบบ streaming
 */
import React from "react";

interface StreamLoadingOverlayProps {
  /** กำลังโหลดอยู่หรือไม่ */
  loading: boolean;
  /** จำนวนสัญญาที่โหลดมาแล้ว */
  progress: number;
  /** จำนวนสัญญาทั้งหมด (0 = ยังไม่รู้) */
  total: number;
  /** ข้อความ label (default: "กำลังโหลดข้อมูล...") */
  label?: string;
  /** เวลาที่ใช้ไป (วินาที) */
  elapsedSec?: number;
  /** แสดงเป็น overlay ทับหน้าจอ หรือ inline block */
  variant?: "overlay" | "inline";
}

export function StreamLoadingOverlay({
  loading,
  progress,
  total,
  label = "กำลังโหลดข้อมูล...",
  elapsedSec,
  variant = "inline",
}: StreamLoadingOverlayProps) {
  if (!loading) return null;

  const pct = total > 0 ? Math.min(100, Math.round((progress / total) * 100)) : null;

  const content = (
    <div className="flex flex-col items-center gap-3 py-8 px-4">
      {/* Spinner */}
      <div className="relative w-10 h-10">
        <div className="absolute inset-0 rounded-full border-4 border-gray-200" />
        <div className="absolute inset-0 rounded-full border-4 border-orange-500 border-t-transparent animate-spin" />
      </div>

      {/* Label + elapsed */}
      <div className="text-center">
        <p className="text-sm font-medium text-gray-700">
          {label}
          {elapsedSec != null && elapsedSec > 0 && (
            <span className="ml-2 text-gray-400 font-normal">({elapsedSec} วินาที)</span>
          )}
        </p>
        {total > 0 && (
          <p className="text-xs text-gray-500 mt-0.5">ข้อมูลมีปริมาณมาก กรุณารอสักครู่...</p>
        )}
      </div>

      {/* Progress bar */}
      <div className="w-full max-w-xs">
        {total > 0 ? (
          <>
            {/* Determinate */}
            <div className="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
              <div
                className="h-2 rounded-full bg-orange-500 transition-all duration-300"
                style={{ width: `${pct}%` }}
              />
            </div>
            <p className="text-center text-xs text-blue-600 mt-1 font-medium">
              โหลดแล้ว {progress.toLocaleString()} / {total.toLocaleString()} สัญญา
              {pct != null && <span className="ml-1 text-gray-400">({pct}%)</span>}
            </p>
          </>
        ) : (
          <>
            {/* Indeterminate */}
            <div className="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
              <div className="h-2 rounded-full bg-orange-500 animate-[loading-bar_1.5s_ease-in-out_infinite]" />
            </div>
            {progress > 0 && (
              <p className="text-center text-xs text-blue-600 mt-1 font-medium">
                โหลดแล้ว {progress.toLocaleString()} สัญญา
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );

  if (variant === "overlay") {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-white/80 backdrop-blur-sm">
        <div className="bg-white rounded-2xl shadow-xl border border-gray-100 px-8 py-6 min-w-[280px]">
          {content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center w-full">
      <div className="w-full max-w-sm">{content}</div>
    </div>
  );
}

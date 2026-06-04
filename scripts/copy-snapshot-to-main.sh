#!/bin/bash
# copy-snapshot-to-main.sh
#
# Copy snapshot rows จาก DB copy (PITR restore) กลับไปยัง DB หลัก
# สำหรับเดือน 2026-06 เท่านั้น
#
# Usage:
#   ./scripts/copy-snapshot-to-main.sh boonphone <SOURCE_DB_URL>
#   ./scripts/copy-snapshot-to-main.sh fastfone <SOURCE_DB_URL>

set -e

SECTION="$1"
SOURCE_URL="$2"
TARGET_MONTH="2026-06"

if [[ -z "$SECTION" || -z "$SOURCE_URL" ]]; then
  echo "Usage: $0 <boonphone|fastfone> <SOURCE_DB_URL>"
  exit 1
fi

# โหลด .env เพื่อดึง TARGET URL
set -a
source "$(dirname "$0")/../.env"
set +a

if [[ "$SECTION" == "boonphone" ]]; then
  TARGET_URL="$BOONPHONE_DATABASE_URL"
elif [[ "$SECTION" == "fastfone" ]]; then
  TARGET_URL="$FASTFONE_DATABASE_URL"
else
  echo "ERROR: section ต้องเป็น boonphone หรือ fastfone"
  exit 1
fi

echo "========================================"
echo "[copy-snapshot] section: $SECTION"
echo "[copy-snapshot] target_month: $TARGET_MONTH"
echo "========================================"

# ── ตรวจสอบว่า source DB มีข้อมูล snapshot เดือน 2026-06 ──────────────────
echo ""
echo "[Step 1] ตรวจสอบ snapshot ใน source DB..."

COLL_COUNT=$(psql "$SOURCE_URL" -t -c "SELECT COUNT(*) FROM monthly_collection_snapshot WHERE collection_month = '$TARGET_MONTH' AND section = '$SECTION';" 2>&1 | tr -d ' ')
DETAIL_COUNT=$(psql "$SOURCE_URL" -t -c "SELECT COUNT(*) FROM monthly_target_detail_snapshot WHERE snapshot_month = '$TARGET_MONTH' AND section = '$SECTION';" 2>&1 | tr -d ' ')

echo "  monthly_collection_snapshot: $COLL_COUNT rows"
echo "  monthly_target_detail_snapshot: $DETAIL_COUNT rows"

if [[ "$COLL_COUNT" == "0" && "$DETAIL_COUNT" == "0" ]]; then
  echo "ERROR: ไม่พบ snapshot ใน source DB สำหรับเดือน $TARGET_MONTH"
  exit 1
fi

# ── ตรวจสอบ target DB ก่อน copy ─────────────────────────────────────────────
echo ""
echo "[Step 2] ตรวจสอบ snapshot ที่มีอยู่ใน target DB..."

COLL_TARGET=$(psql "$TARGET_URL" -t -c "SELECT COUNT(*) FROM monthly_collection_snapshot WHERE collection_month = '$TARGET_MONTH' AND section = '$SECTION';" 2>&1 | tr -d ' ')
DETAIL_TARGET=$(psql "$TARGET_URL" -t -c "SELECT COUNT(*) FROM monthly_target_detail_snapshot WHERE snapshot_month = '$TARGET_MONTH' AND section = '$SECTION';" 2>&1 | tr -d ' ')

echo "  monthly_collection_snapshot (target): $COLL_TARGET rows"
echo "  monthly_target_detail_snapshot (target): $DETAIL_TARGET rows"

# ── Export snapshot จาก source DB ────────────────────────────────────────────
echo ""
echo "[Step 3] Export snapshot จาก source DB..."

TMPDIR=$(mktemp -d)
COLL_FILE="$TMPDIR/collection_snapshot.csv"
DETAIL_FILE="$TMPDIR/target_detail_snapshot.csv"

# Export monthly_collection_snapshot (ยกเว้น id ที่เป็น generated always)
COLL_COLS="section, collection_month, target_amount, target_contract_count, target_frozen_at, collected_amount, collected_contract_count, collected_frozen_at, collected_is_frozen, install_total, target_principal, target_interest, target_fee, target_penalty, target_unlock_fee, collected_principal, collected_interest, collected_fee, collected_penalty, collected_unlock_fee, collected_discount, collected_overpaid, collected_bad_debt, created_at, updated_at, financed_total, overdue_total, collected_sale"

psql "$SOURCE_URL" -c "\COPY (SELECT $COLL_COLS FROM monthly_collection_snapshot WHERE collection_month = '$TARGET_MONTH' AND section = '$SECTION') TO '$COLL_FILE' WITH CSV HEADER"
echo "  ✓ monthly_collection_snapshot exported: $(wc -l < "$COLL_FILE") lines"

# Export monthly_target_detail_snapshot (ยกเว้น id ที่เป็น generated always)
DETAIL_COLS="section, snapshot_month, contract_external_id, contract_no, customer_name, partner_code, partner_name, approve_date, product_type, device, model, finance_amount, installment_count, baseline_amount, period, due_date, principal, interest, fee, penalty, unlock_fee, total_amount, paid_amount, contract_status, debt_range, is_paid, is_arrears, is_bad_debt, is_closed, is_suspended, is_current_period, is_future_period, populated_at, snapshot_mode, cutoff_date, filter_debt_only, filter_principal_only, phone, filter_state"

psql "$SOURCE_URL" -c "\COPY (SELECT $DETAIL_COLS FROM monthly_target_detail_snapshot WHERE snapshot_month = '$TARGET_MONTH' AND section = '$SECTION') TO '$DETAIL_FILE' WITH CSV HEADER"
echo "  ✓ monthly_target_detail_snapshot exported: $(wc -l < "$DETAIL_FILE") lines"

# ── ลบ snapshot เดือน 2026-06 ออกจาก target DB ก่อน insert ──────────────────
echo ""
echo "[Step 4] ลบ snapshot เดือน $TARGET_MONTH ออกจาก target DB..."

psql "$TARGET_URL" -c "DELETE FROM monthly_collection_snapshot WHERE collection_month = '$TARGET_MONTH' AND section = '$SECTION';"
echo "  ✓ monthly_collection_snapshot deleted"

psql "$TARGET_URL" -c "DELETE FROM monthly_target_detail_snapshot WHERE snapshot_month = '$TARGET_MONTH' AND section = '$SECTION';"
echo "  ✓ monthly_target_detail_snapshot deleted"

# ── Import snapshot เข้า target DB ──────────────────────────────────────────
echo ""
echo "[Step 5] Import snapshot เข้า target DB..."

psql "$TARGET_URL" -c "\COPY monthly_collection_snapshot ($COLL_COLS) FROM '$COLL_FILE' WITH CSV HEADER"
echo "  ✓ monthly_collection_snapshot imported"

psql "$TARGET_URL" -c "\COPY monthly_target_detail_snapshot ($DETAIL_COLS) FROM '$DETAIL_FILE' WITH CSV HEADER"
echo "  ✓ monthly_target_detail_snapshot imported"

# ── ตรวจสอบผลลัพธ์ ────────────────────────────────────────────────────────────
echo ""
echo "[Step 6] ตรวจสอบผลลัพธ์..."

COLL_FINAL=$(psql "$TARGET_URL" -t -c "SELECT COUNT(*) FROM monthly_collection_snapshot WHERE collection_month = '$TARGET_MONTH' AND section = '$SECTION';" 2>&1 | tr -d ' ')
DETAIL_FINAL=$(psql "$TARGET_URL" -t -c "SELECT COUNT(*) FROM monthly_target_detail_snapshot WHERE snapshot_month = '$TARGET_MONTH' AND section = '$SECTION';" 2>&1 | tr -d ' ')

echo "  monthly_collection_snapshot: $COLL_FINAL rows (เดิม: $COLL_TARGET)"
echo "  monthly_target_detail_snapshot: $DETAIL_FINAL rows (เดิม: $DETAIL_TARGET)"

# Cleanup
rm -rf "$TMPDIR"

echo ""
echo "========================================"
echo "[copy-snapshot] COMPLETED for $SECTION"
echo "  collection_snapshot: $COLL_FINAL rows"
echo "  target_detail_snapshot: $DETAIL_FINAL rows"
echo "========================================"

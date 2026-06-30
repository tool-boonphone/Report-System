#!/usr/bin/env python3
"""
Restore dropdown snapshot (monthly_target_detail_snapshot + monthly_collection_snapshot)
from Parquet exports.

Usage:
  export FASTFONE_DATABASE_URL='postgresql://...'
  python3 scripts/restore_snapshot_from_parquet.py \\
    --section Fastfone365 \\
    --month 2026-06 \\
    --mtds /path/ff365_mtds_202606.parquet \\
    --mcs /path/ff365_mcs_202606.parquet

  # dry-run (no DB writes):
  python3 scripts/restore_snapshot_from_parquet.py ... --dry-run

Requires: pyarrow, pandas, psycopg2-binary
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
from typing import Any

import pandas as pd
import psycopg2
from psycopg2.extras import execute_values

MTDS_COLS = [
    "section",
    "snapshot_month",
    "contract_external_id",
    "contract_no",
    "customer_name",
    "partner_code",
    "partner_name",
    "approve_date",
    "product_type",
    "device",
    "model",
    "finance_amount",
    "installment_count",
    "baseline_amount",
    "period",
    "due_date",
    "principal",
    "interest",
    "fee",
    "penalty",
    "unlock_fee",
    "total_amount",
    "paid_amount",
    "contract_status",
    "debt_range",
    "is_paid",
    "is_arrears",
    "is_bad_debt",
    "is_closed",
    "is_suspended",
    "is_current_period",
    "is_future_period",
    "populated_at",
    "snapshot_mode",
    "cutoff_date",
    "filter_debt_only",
    "filter_principal_only",
    "phone",
    "filter_state",
]

MCS_COLS = [
    "section",
    "collection_month",
    "target_amount",
    "target_contract_count",
    "target_frozen_at",
    "target_principal",
    "target_interest",
    "target_fee",
    "target_penalty",
    "target_unlock_fee",
    "collected_amount",
    "collected_contract_count",
    "collected_frozen_at",
    "collected_is_frozen",
    "collected_principal",
    "collected_interest",
    "collected_fee",
    "collected_penalty",
    "collected_unlock_fee",
    "collected_discount",
    "collected_overpaid",
    "collected_bad_debt",
    "install_total",
    "financed_total",
    "overdue_total",
    "collected_sale",
    "created_at",
    "updated_at",
    "target_by_range",
    "daily_breakdown",
]


def clean(val: Any) -> Any:
    if val is None:
        return None
    if isinstance(val, float) and (math.isnan(val) or math.isinf(val)):
        return None
    if isinstance(val, pd.Timestamp):
        return val.to_pydatetime()
    if isinstance(val, (dict, list)):
        return json.dumps(val, ensure_ascii=False)
    if isinstance(val, str) and val in ("", "NaT"):
        return None
    return val


def load_parquet(path: str) -> pd.DataFrame:
    df = pd.read_parquet(path)
    print(f"[restore] loaded {path} — {len(df)} rows, {len(df.columns)} cols")
    return df


def validate(df: pd.DataFrame, section: str, month: str, month_col: str) -> None:
    if len(df) == 0:
        raise SystemExit(f"[restore] ERROR: empty parquet")
    bad_section = df[df["section"] != section]
    if len(bad_section):
        raise SystemExit(f"[restore] ERROR: section mismatch — expected {section}")
    bad_month = df[df[month_col] != month]
    if len(bad_month):
        raise SystemExit(f"[restore] ERROR: month mismatch — expected {month}, got {bad_month[month_col].unique()[:5]}")


def rows_from_df(df: pd.DataFrame, columns: list[str]) -> list[tuple]:
    missing = [c for c in columns if c not in df.columns]
    if missing:
        raise SystemExit(f"[restore] ERROR: parquet missing columns: {missing}")
    out: list[tuple] = []
    for _, row in df[columns].iterrows():
        out.append(tuple(clean(row[c]) for c in columns))
    return out


def restore(section: str, month: str, mtds_path: str, mcs_path: str, db_url: str, dry_run: bool) -> None:
    mtds_df = load_parquet(mtds_path)
    mcs_df = load_parquet(mcs_path)
    validate(mtds_df, section, month, "snapshot_month")
    validate(mcs_df, section, month, "collection_month")

    mtds_rows = rows_from_df(mtds_df, MTDS_COLS)
    mcs_rows = rows_from_df(mcs_df, MCS_COLS)

    print(f"[restore] section={section} month={month}")
    print(f"[restore] mtds rows to insert: {len(mtds_rows)}")
    print(f"[restore] mcs rows to insert: {len(mcs_rows)}")

    if dry_run:
        print("[restore] dry-run — no DB changes")
        return

    conn = psycopg2.connect(db_url)
    conn.autocommit = False
    try:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM monthly_target_detail_snapshot WHERE section = %s AND snapshot_month = %s",
                (section, month),
            )
            deleted_mtds = cur.rowcount
            cur.execute(
                "DELETE FROM monthly_collection_snapshot WHERE section = %s AND collection_month = %s",
                (section, month),
            )
            deleted_mcs = cur.rowcount
            print(f"[restore] deleted mtds={deleted_mtds} mcs={deleted_mcs}")

            mcs_sql = f"""
                INSERT INTO monthly_collection_snapshot ({", ".join(MCS_COLS)})
                VALUES %s
                ON CONFLICT (section, collection_month) DO UPDATE SET
                  target_amount = EXCLUDED.target_amount,
                  target_contract_count = EXCLUDED.target_contract_count,
                  target_frozen_at = EXCLUDED.target_frozen_at,
                  target_principal = EXCLUDED.target_principal,
                  target_interest = EXCLUDED.target_interest,
                  target_fee = EXCLUDED.target_fee,
                  target_penalty = EXCLUDED.target_penalty,
                  target_unlock_fee = EXCLUDED.target_unlock_fee,
                  collected_amount = EXCLUDED.collected_amount,
                  collected_contract_count = EXCLUDED.collected_contract_count,
                  collected_frozen_at = EXCLUDED.collected_frozen_at,
                  collected_is_frozen = EXCLUDED.collected_is_frozen,
                  collected_principal = EXCLUDED.collected_principal,
                  collected_interest = EXCLUDED.collected_interest,
                  collected_fee = EXCLUDED.collected_fee,
                  collected_penalty = EXCLUDED.collected_penalty,
                  collected_unlock_fee = EXCLUDED.collected_unlock_fee,
                  collected_discount = EXCLUDED.collected_discount,
                  collected_overpaid = EXCLUDED.collected_overpaid,
                  collected_bad_debt = EXCLUDED.collected_bad_debt,
                  install_total = EXCLUDED.install_total,
                  financed_total = EXCLUDED.financed_total,
                  overdue_total = EXCLUDED.overdue_total,
                  collected_sale = EXCLUDED.collected_sale,
                  target_by_range = EXCLUDED.target_by_range,
                  daily_breakdown = EXCLUDED.daily_breakdown,
                  updated_at = NOW()
            """
            execute_values(cur, mcs_sql, mcs_rows, page_size=10)

            mtds_sql = f"""
                INSERT INTO monthly_target_detail_snapshot ({", ".join(MTDS_COLS)})
                VALUES %s
            """
            batch = 5000
            for i in range(0, len(mtds_rows), batch):
                chunk = mtds_rows[i : i + batch]
                execute_values(cur, mtds_sql, chunk, page_size=1000)
                print(f"[restore] mtds inserted {min(i + batch, len(mtds_rows))}/{len(mtds_rows)}")

            cur.execute(
                "SELECT COUNT(*) FROM monthly_target_detail_snapshot WHERE section = %s AND snapshot_month = %s",
                (section, month),
            )
            mtds_count = cur.fetchone()[0]
            cur.execute(
                "SELECT COUNT(*) FROM monthly_collection_snapshot WHERE section = %s AND collection_month = %s",
                (section, month),
            )
            mcs_count = cur.fetchone()[0]
        conn.commit()
        print(f"[restore] done — mtds={mtds_count} mcs={mcs_count}")
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Restore snapshot tables from Parquet")
    parser.add_argument("--section", default="Fastfone365")
    parser.add_argument("--month", default="2026-06")
    parser.add_argument("--mtds", required=True, help="path to mtds parquet")
    parser.add_argument("--mcs", required=True, help="path to mcs parquet")
    parser.add_argument("--database-url", default=os.environ.get("FASTFONE_DATABASE_URL", ""))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if not args.dry_run and not args.database_url:
        raise SystemExit("Set FASTFONE_DATABASE_URL or pass --database-url")

    restore(
        section=args.section,
        month=args.month,
        mtds_path=args.mtds,
        mcs_path=args.mcs,
        db_url=args.database_url,
        dry_run=args.dry_run,
    )


if __name__ == "__main__":
    main()

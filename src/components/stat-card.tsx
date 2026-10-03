"use client";

import type { Health } from "@/lib/format";
import { HealthDot } from "@/components/ui";
import { Skeleton } from "@/components/ui";

interface Props {
  label: string;
  value: string;
  sub?: string;
  health?: Health;
  loading?: boolean;
}

export function StatCard({ label, value, sub, health, loading }: Props) {
  return (
    <div className="pv-card p-4 sm:p-5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        {health && <HealthDot health={health} />}
      </div>
      {loading ? (
        <Skeleton className="mt-3 h-7 w-24" />
      ) : (
        <div className="mt-2 text-2xl font-semibold tracking-tight tabular-nums">
          {value}
        </div>
      )}
      {sub && !loading && (
        <div className="mt-1 text-xs text-muted-foreground">{sub}</div>
      )}
    </div>
  );
}

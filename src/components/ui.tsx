"use client";

import type { Health } from "@/lib/format";

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <span
      className="inline-block animate-spin rounded-full border-2 border-current border-t-transparent"
      style={{ width: size, height: size }}
      aria-hidden
    />
  );
}

const HEALTH_COLOR: Record<Health, string> = {
  good: "bg-success",
  warn: "bg-warning",
  bad: "bg-danger",
  neutral: "bg-muted-foreground/40",
};

const HEALTH_TEXT: Record<Health, string> = {
  good: "text-success",
  warn: "text-warning",
  bad: "text-danger",
  neutral: "text-muted-foreground",
};

export function HealthDot({ health }: { health: Health }) {
  return (
    <span className={`inline-block h-2 w-2 rounded-full ${HEALTH_COLOR[health]}`} />
  );
}

export function healthText(health: Health) {
  return HEALTH_TEXT[health];
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-muted ${className}`} />;
}

export function EmptyState({
  icon,
  title,
  children,
}: {
  icon?: React.ReactNode;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="pv-card flex flex-col items-center justify-center px-6 py-14 text-center">
      {icon && (
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
          {icon}
        </div>
      )}
      <h3 className="text-base font-semibold">{title}</h3>
      {children && (
        <div className="mt-1.5 max-w-sm text-sm text-muted-foreground">
          {children}
        </div>
      )}
    </div>
  );
}

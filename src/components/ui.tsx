"use client";

import { useEffect, useState } from "react";
import type { Health } from "@/lib/format";
import { ChevronDownIcon } from "@/components/icons";

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

/**
 * "Remove" action for a finished job card. The first click arms it and the
 * second confirms, so a stray click can't wipe a run's results; the armed
 * state disarms itself after a few seconds.
 */
export function RemoveJobButton({
  onRemove,
  disabled,
  label = "Remove",
}: {
  onRemove: () => void | Promise<void>;
  disabled?: boolean;
  /** Worth setting where another button on the card also says "Remove". */
  label?: string;
}) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 5000);
    return () => clearTimeout(t);
  }, [armed]);

  return (
    <button
      type="button"
      className={`pv-btn-ghost ${armed ? "text-danger" : ""}`}
      disabled={disabled || busy}
      onClick={async () => {
        if (!armed) {
          setArmed(true);
          return;
        }
        setBusy(true);
        try {
          await onRemove();
        } finally {
          setBusy(false);
          setArmed(false);
        }
      }}
    >
      {busy ? <Spinner size={14} /> : null}
      {armed ? "Confirm remove" : label}
    </button>
  );
}

/**
 * A long table folded away behind its own header.
 *
 * A scan can turn up hundreds of rows, and the numbers above the table are
 * what most runs are read for — so the list gets a header that says how many
 * are in it and opens on a click, rather than pushing everything else off
 * the screen.
 */
export function TableDisclosure({
  open,
  onToggle,
  label,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  /** What is inside — "11 burned inboxes". Shown open or closed. */
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 bg-muted/40 px-3 py-2 text-left text-xs text-muted-foreground hover:text-foreground"
        onClick={onToggle}
        aria-expanded={open}
        data-table-toggle
      >
        <ChevronDownIcon
          size={13}
          className={`shrink-0 transition-transform ${open ? "" : "-rotate-90"}`}
        />
        <span>{label}</span>
        <span className="ml-auto">{open ? "Hide" : "Show"}</span>
      </button>
      {open && <div className="border-t border-border">{children}</div>}
    </div>
  );
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

"use client";

// The signature inputs — the fixed slots for titles, company names, phones and
// addresses — shared by any tool that sets signatures as one
// of its steps, so they all offer the same fields.

export const TITLE_SLOTS = 5;
export const COMPANY_SLOTS = 3;
export const PHONE_SLOTS = 5;
export const ADDRESS_SLOTS = 3;

// The role pool lives in lib so server code (the automated Start Outreach
// run) picks titles the same way.
export { DEFAULT_ROLES, pickRandomRoles } from "@/lib/signatures/roles";

/** Spreads saved values across a fixed number of slots, padding the rest. */
export function padSlots(values: string[], slots: number): string[] {
  return Array.from({ length: slots }, (_, i) => values[i] ?? "");
}

export function SlotGroup({
  label,
  hint,
  values,
  onChange,
  placeholder,
  headerAction,
  disabled,
}: {
  label: string;
  hint?: string;
  values: string[];
  onChange: (v: string[]) => void;
  placeholder: string;
  headerAction?: React.ReactNode;
  disabled?: boolean;
}) {
  const filled = values.filter((v) => v.trim()).length;
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <label className="text-xs font-medium text-muted-foreground">
          {label}{" "}
          <span className="text-muted-foreground/70">
            ({filled}/{values.length}
            {hint ? ` · ${hint}` : ""})
          </span>
        </label>
        {headerAction}
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {values.map((v, i) => (
          <input
            key={i}
            className="pv-input"
            placeholder={i === 0 ? placeholder : `${placeholder} (alt ${i})`}
            value={v}
            disabled={disabled}
            aria-label={`${label} ${i + 1}`}
            onChange={(e) => {
              const next = [...values];
              next[i] = e.target.value;
              onChange(next);
            }}
          />
        ))}
      </div>
    </div>
  );
}

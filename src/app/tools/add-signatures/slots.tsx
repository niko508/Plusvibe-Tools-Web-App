"use client";

// The signature inputs — the fixed slots for titles, company names, phones and
// addresses — shared by Add Signatures and any tool that sets signatures as one
// of its steps, so both offer exactly the same fields.

export const TITLE_SLOTS = 5;
export const COMPANY_SLOTS = 3;
export const PHONE_SLOTS = 5;
export const ADDRESS_SLOTS = 3;

// Default pool of roles; the title slots start pre-filled with a random pick.
export const DEFAULT_ROLES = [
  "Account Executive",
  "Key Account Executive",
  "Growth Manager",
  "Business Development",
  "Head of Growth",
  "Growth Director",
  "Growth Lead",
  "Head of Business Development",
  "BDR Manager",
  "BDR",
  "Business Development Representative",
  "Partnerships Manager",
];

export function pickRandomRoles(n: number): string[] {
  const pool = [...DEFAULT_ROLES];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const picked = pool.slice(0, n);
  while (picked.length < n) picked.push("");
  return picked;
}

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

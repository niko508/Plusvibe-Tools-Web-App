"use client";

import { useEffect, useRef, useState } from "react";
import {
  getSheetConfig,
  setSheetConfig,
  clearSheetConfig,
  DEFAULT_SHEET_TAB,
} from "@/lib/sheet-config";
import { fetchSheetMap } from "@/lib/api-client";
import { SheetIcon, CheckIcon, AlertIcon } from "@/components/icons";

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
}

type TestState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok"; domains: number; clients: number }
  | { kind: "error"; message: string };

export function SheetDialog({ open, onClose, onSaved }: Props) {
  const [url, setUrl] = useState("");
  const [tab, setTab] = useState(DEFAULT_SHEET_TAB);
  const [test, setTest] = useState<TestState>({ kind: "idle" });
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      const cfg = getSheetConfig();
      setUrl(cfg?.url ?? "");
      setTab(cfg?.tab ?? DEFAULT_SHEET_TAB);
      setTest({ kind: "idle" });
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  async function handleSave() {
    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
      setTest({ kind: "error", message: "Paste your Google Sheet share URL." });
      return;
    }
    const cleanTab = tab.trim() || DEFAULT_SHEET_TAB;
    setSheetConfig({ url: trimmedUrl, tab: cleanTab });
    setTest({ kind: "testing" });
    try {
      const res = await fetchSheetMap({ url: trimmedUrl, tab: cleanTab });
      setTest({ kind: "ok", domains: res.domains, clients: res.clients });
      onSaved?.();
      setTimeout(onClose, 800);
    } catch (err) {
      setTest({
        kind: "error",
        message: err instanceof Error ? err.message : "Could not read the sheet.",
      });
    }
  }

  function handleClear() {
    clearSheetConfig();
    setUrl("");
    setTab(DEFAULT_SHEET_TAB);
    setTest({ kind: "idle" });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-[12vh] backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <div
        className="pv-card w-full max-w-md animate-fade-in p-6"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="mb-4 flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <SheetIcon size={20} />
          </span>
          <div>
            <h2 className="text-base font-semibold">Email Infra sheet</h2>
            <p className="text-xs text-muted-foreground">
              Maps domains → client → workspace to speed up scans.
            </p>
          </div>
        </div>

        <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
          Google Sheet URL
        </label>
        <input
          ref={inputRef}
          type="url"
          autoComplete="off"
          spellCheck={false}
          className="pv-input"
          placeholder="https://docs.google.com/spreadsheets/d/…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />

        <label className="mb-1.5 mt-3 block text-xs font-medium text-muted-foreground">
          Tab name
        </label>
        <input
          type="text"
          spellCheck={false}
          className="pv-input"
          placeholder={DEFAULT_SHEET_TAB}
          value={tab}
          onChange={(e) => setTab(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSave();
          }}
        />

        <p className="mt-2 text-xs text-muted-foreground">
          The sheet must be shared as{" "}
          <strong>&ldquo;anyone with the link can view&rdquo;</strong>. Columns
          are matched by header name (<code>Domain</code>, <code>Client</code>).
        </p>

        {test.kind === "ok" && (
          <div className="mt-3 flex items-center gap-2 rounded-xl bg-success/10 px-3 py-2 text-sm text-success">
            <CheckIcon size={16} />
            Synced · {test.domains} domains across {test.clients} clients
          </div>
        )}
        {test.kind === "error" && (
          <div className="mt-3 flex items-start gap-2 rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
            <AlertIcon size={16} className="mt-0.5 shrink-0" />
            <span>{test.message}</span>
          </div>
        )}

        <div className="mt-5 flex items-center justify-between gap-3">
          <button type="button" className="pv-btn-ghost" onClick={handleClear}>
            Clear
          </button>
          <div className="flex gap-2">
            <button type="button" className="pv-btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="pv-btn-primary"
              onClick={handleSave}
              disabled={test.kind === "testing"}
            >
              {test.kind === "testing" ? "Syncing…" : "Save & sync"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { getApiKey, setApiKey, clearApiKey } from "@/lib/api-key";
import { fetchWorkspaces } from "@/lib/api-client";
import { KeyIcon, CheckIcon, AlertIcon } from "@/components/icons";

interface Props {
  open: boolean;
  onClose: () => void;
  // Called after a key is successfully saved & validated.
  onSaved?: () => void;
}

type TestState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok"; workspaces: number }
  | { kind: "error"; message: string };

export function ApiKeyDialog({ open, onClose, onSaved }: Props) {
  const [value, setValue] = useState("");
  const [test, setTest] = useState<TestState>({ kind: "idle" });
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setValue(getApiKey() ?? "");
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
    const trimmed = value.trim();
    if (!trimmed) {
      setTest({ kind: "error", message: "Enter an API key." });
      return;
    }
    // Persist first so fetchWorkspaces() forwards the new key, then validate.
    setApiKey(trimmed);
    setTest({ kind: "testing" });
    try {
      const res = await fetchWorkspaces();
      setTest({ kind: "ok", workspaces: res.workspaces?.length ?? 0 });
      onSaved?.();
      setTimeout(onClose, 700);
    } catch (err) {
      setTest({
        kind: "error",
        message: err instanceof Error ? err.message : "Could not validate key.",
      });
    }
  }

  function handleClear() {
    clearApiKey();
    setValue("");
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
            <KeyIcon size={20} />
          </span>
          <div>
            <h2 className="text-base font-semibold">Plusvibe API key</h2>
            <p className="text-xs text-muted-foreground">
              Stored only in this browser. Never sent anywhere but Plusvibe.
            </p>
          </div>
        </div>

        <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
          API key
        </label>
        <input
          ref={inputRef}
          type="password"
          autoComplete="off"
          spellCheck={false}
          className="pv-input font-mono"
          placeholder="pv_live_..."
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSave();
          }}
        />

        <p className="mt-2 text-xs text-muted-foreground">
          Get one under{" "}
          <a
            href="https://app.plusvibe.ai/v2/settings/api-access/"
            target="_blank"
            rel="noreferrer"
            className="text-accent underline underline-offset-2"
          >
            Settings → API access
          </a>{" "}
          (Business plan).
        </p>

        {test.kind === "ok" && (
          <div className="mt-3 flex items-center gap-2 rounded-xl bg-success/10 px-3 py-2 text-sm text-success">
            <CheckIcon size={16} />
            Connected · {test.workspaces} workspace
            {test.workspaces === 1 ? "" : "s"} available
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
              {test.kind === "testing" ? "Checking…" : "Save & connect"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

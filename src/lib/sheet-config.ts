"use client";

// The Email Infra Google Sheet config (URL + tab) used to speed up the Remove
// Inboxes scan. Stored only in the browser's localStorage, like the API key.

const STORAGE_KEY = "pv_sheet_config";
const EVENT = "pv-sheet-config-changed";

export const DEFAULT_SHEET_TAB = "📋 Domains";

export interface SheetConfig {
  url: string;
  tab: string;
}

export function getSheetConfig(): SheetConfig | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SheetConfig>;
    if (!parsed.url) return null;
    return { url: parsed.url, tab: parsed.tab || DEFAULT_SHEET_TAB };
  } catch {
    return null;
  }
}

export function setSheetConfig(config: SheetConfig) {
  if (typeof window === "undefined") return;
  const url = config.url.trim();
  if (!url) {
    clearSheetConfig();
    return;
  }
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ url, tab: config.tab.trim() || DEFAULT_SHEET_TAB })
  );
  window.dispatchEvent(new Event(EVENT));
}

export function clearSheetConfig() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
  window.dispatchEvent(new Event(EVENT));
}

export function onSheetConfigChange(cb: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}

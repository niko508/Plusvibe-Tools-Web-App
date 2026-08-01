"use client";

import { useEffect, useState } from "react";
import {
  getSheetConfig,
  onSheetConfigChange,
  type SheetConfig,
} from "@/lib/sheet-config";

// Reactive view of the synced sheet config in this browser.
export function useSheetConfig() {
  const [config, setConfig] = useState<SheetConfig | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const sync = () => setConfig(getSheetConfig());
    sync();
    setReady(true);
    return onSheetConfigChange(sync);
  }, []);

  return { config, hasSheet: !!config, ready };
}

"use client";

import { useEffect, useState } from "react";
import { getApiKey, onApiKeyChange } from "@/lib/api-key";

// Reactive view of whether an API key is currently set in this browser.
export function useApiKey() {
  const [key, setKey] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const sync = () => setKey(getApiKey());
    sync();
    setReady(true);
    return onApiKeyChange(sync);
  }, []);

  return { apiKey: key, hasKey: !!key, ready };
}

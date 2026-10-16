"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { onApiKeyChange, getApiKey } from "@/lib/api-key";
import { fetchGeneralSettings } from "@/lib/api-client";
import {
  generalSettings,
  generalSettingsState,
  onGeneralSettingsChange,
  setGeneralSettings,
  type GeneralSettings,
} from "./settings";

// The browser's copy of General Settings. Fetched once when the app opens (and
// again when the API key changes), then put in force for every component and
// module that reads generalSettings(). Components that show a value call
// useGeneralSettings() so they re-render when the copy arrives or is saved.

let inflight: Promise<void> | null = null;

/** Fetches the saved settings and puts them in force. Quiet on failure: the defaults stay. */
export function refreshGeneralSettings(): Promise<void> {
  if (!getApiKey()) return Promise.resolve();
  inflight ??= fetchGeneralSettings()
    .then((r) => setGeneralSettings(r.settings, r.updatedAt))
    .catch(() => undefined)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Mounted once, in the root layout. */
export function GeneralSettingsSync() {
  useEffect(() => {
    void refreshGeneralSettings();
    return onApiKeyChange(() => void refreshGeneralSettings());
  }, []);
  return null;
}

const serverSnapshot = () => 0;

/**
 * The settings in force, and whether the saved ones have arrived. Before they
 * do, `settings` is the defaults — a tool that SENDS a value to the server
 * (rather than just showing it) should wait for `loaded`.
 */
export function useGeneralSettings(): { settings: GeneralSettings; loaded: boolean; updatedAt: number } {
  useSyncExternalStore(onGeneralSettingsChange, () => generalSettingsState().version, serverSnapshot);
  const state = generalSettingsState();
  return { settings: generalSettings(), loaded: state.loaded, updatedAt: state.updatedAt };
}

/**
 * A form field whose starting value comes from General Settings, e.g. the
 * sheet link. It follows the settings — the saved copy arriving after the page
 * opened, or a save in another tab — until someone edits it; from then on it
 * is theirs.
 */
export function useSettingField<T>(read: (s: GeneralSettings) => T): [T, (v: T) => void] {
  const { settings } = useGeneralSettings();
  const [value, setValue] = useState<T>(() => read(settings));
  const edited = useRef(false);
  const readRef = useRef(read);
  readRef.current = read;
  useEffect(() => {
    if (!edited.current) setValue(readRef.current(settings));
  }, [settings]);
  const set = useCallback((v: T) => {
    edited.current = true;
    setValue(v);
  }, []);
  return [value, set];
}

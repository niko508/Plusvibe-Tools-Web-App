"use client";

// What happens around a Create all types / Add more leads run, said once
// beside its button, with a warning when the ESP app isn't connected.

import { useEffect, useState } from "react";
import { AlertIcon } from "@/components/icons";

export function useEspConnected(): boolean | null {
  const [connected, setConnected] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/esp/status")
      .then((r) => r.json())
      .then((b: { connected?: boolean }) => !cancelled && setConnected(b.connected === true))
      .catch(() => !cancelled && setConnected(null));
    return () => {
      cancelled = true;
    };
  }, []);
  return connected;
}

export function WorkspaceFlowNote() {
  const connected = useEspConnected();
  return (
    <div className="space-y-1.5 text-xs text-muted-foreground" data-workspace-flow-note>
      <p>
        It runs on the server — close the tab whenever you like. First every running campaign in the workspace is paused
        (sub-sequences left alone); then the campaigns and leads are done; then the ESP app&apos;s Manual Run sets this
        workspace&apos;s limits; and last every campaign that isn&apos;t running is launched (archived ones aside). Stopping the
        job launches the paused ones again. The result is in Jobs below.
      </p>
      {connected === false && (
        <p className="flex items-start gap-1.5 text-warning" data-esp-not-connected>
          <AlertIcon size={13} className="mt-0.5 shrink-0" />
          <span>
            The ESP app isn&apos;t connected, so the Manual Run step will fail and be reported — the campaigns are still launched.
            Set ESP_APP_URL (and ESP_APP_PASSWORD, if it has a password) on this app&apos;s Railway service.
          </span>
        </p>
      )}
    </div>
  );
}

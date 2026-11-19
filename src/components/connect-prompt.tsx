"use client";

import { useState } from "react";
import { ApiKeyDialog } from "@/components/api-key-dialog";
import { KeyIcon } from "@/components/icons";
import { EmptyState } from "@/components/ui";

// Shown by a tool when no API key is set yet.
export function ConnectPrompt({ onConnected }: { onConnected?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <EmptyState
        icon={<KeyIcon />}
        title="Connect your Plusvibe account"
      >
        <p>
          Add your Plusvibe API key to load workspaces and start monitoring. The
          key stays in your browser.
        </p>
        <button
          type="button"
          className="pv-btn-primary mx-auto mt-5"
          onClick={() => setOpen(true)}
        >
          <KeyIcon size={16} />
          Add API key
        </button>
      </EmptyState>
      <ApiKeyDialog
        open={open}
        onClose={() => setOpen(false)}
        onSaved={onConnected}
      />
    </>
  );
}

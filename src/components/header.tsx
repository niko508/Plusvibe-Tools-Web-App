"use client";

import Link from "next/link";
import { useState } from "react";
import { ThemeToggle } from "@/components/theme";
import { ApiKeyDialog } from "@/components/api-key-dialog";
import { SheetDialog } from "@/components/sheet-dialog";
import { useApiKey } from "@/lib/use-api-key";
import { useSheetConfig } from "@/lib/use-sheet-config";
import { KeyIcon, SheetIcon, ArrowLeftIcon } from "@/components/icons";

interface Props {
  // When set, shows a back link to the left of the brand.
  back?: { href: string; label: string };
}

export function Header({ back }: Props) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const { hasKey, ready } = useApiKey();
  const { hasSheet, ready: sheetReady } = useSheetConfig();

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          {back && (
            <Link
              href={back.href}
              className="pv-chip hover:border-accent/40 hover:text-accent"
            >
              <ArrowLeftIcon size={14} />
              <span className="hidden sm:inline">{back.label}</span>
            </Link>
          )}
          <Link href="/" className="flex items-center gap-2.5">
            <BrandMark />
            <span className="truncate text-sm font-semibold tracking-tight sm:text-base">
              Plusvibe Tools
            </span>
          </Link>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setSheetOpen(true)}
            className="pv-btn-ghost"
            title="Sync your Email Infra Google Sheet"
          >
            <span
              className={`h-2 w-2 rounded-full ${
                sheetReady && hasSheet ? "bg-success" : "bg-muted-foreground/40"
              }`}
            />
            <SheetIcon size={16} />
            <span className="hidden md:inline">
              {sheetReady && hasSheet ? "Sheet synced" : "Sync sheet"}
            </span>
          </button>
          <button
            type="button"
            onClick={() => setDialogOpen(true)}
            className="pv-btn-ghost"
          >
            <span
              className={`h-2 w-2 rounded-full ${
                ready && hasKey ? "bg-success" : "bg-muted-foreground/40"
              }`}
            />
            <KeyIcon size={16} />
            <span className="hidden sm:inline">
              {ready && hasKey ? "Connected" : "Connect"}
            </span>
          </button>
          <ThemeToggle />
        </div>
      </div>

      <ApiKeyDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
      <SheetDialog open={sheetOpen} onClose={() => setSheetOpen(false)} />
    </header>
  );
}

function BrandMark() {
  return (
    <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-accent-foreground shadow-soft">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
        <path
          d="M4 14l5-9 4 7 2-3 5 8"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

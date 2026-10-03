"use client";

import { useState } from "react";
import type { FollowUpTemplate } from "@/lib/follow-ups/templates";
import {
  OFFER_PLACEHOLDER,
  TEMPLATE_SEPARATOR,
  hasPlaceholder,
  joinTemplates,
  newTemplateId,
  splitTemplates,
} from "@/lib/follow-ups/templates";
import { Spinner } from "@/components/ui";
import { AlertIcon, CheckIcon, CopyIcon, TrashIcon } from "@/components/icons";
import { copyToClipboard } from "@/lib/clipboard";

export function TemplatesView({
  templates,
  setTemplates,
  onSave,
  saving,
  dirty,
  loading,
}: {
  templates: FollowUpTemplate[];
  setTemplates: (next: FollowUpTemplate[]) => void;
  onSave: () => void;
  saving: boolean;
  dirty: boolean;
  loading: boolean;
}) {
  const [importOpen, setImportOpen] = useState(false);
  const [importRaw, setImportRaw] = useState("");
  const [copied, setCopied] = useState(false);

  function update(id: string, body: string) {
    setTemplates(templates.map((t) => (t.id === id ? { ...t, body } : t)));
  }

  function remove(id: string) {
    setTemplates(templates.filter((t) => t.id !== id));
  }

  function add() {
    setTemplates([...templates, { id: newTemplateId(), body: "" }]);
  }

  function runImport(mode: "replace" | "append") {
    const parts = splitTemplates(importRaw);
    if (parts.length === 0) return;
    const incoming = parts.map((body) => ({ id: newTemplateId(), body }));
    setTemplates(mode === "replace" ? incoming : [...templates, ...incoming]);
    setImportRaw("");
    setImportOpen(false);
  }

  const missingPlaceholder = templates.filter(
    (t) => t.body.trim() && !hasPlaceholder(t.body)
  ).length;

  if (loading) return <div className="pv-card h-40 animate-pulse" />;

  return (
    <div className="space-y-4">
      <div className="pv-card p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">
              {templates.length} template{templates.length === 1 ? "" : "s"}
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Each one becomes a variant of step 2. Write{" "}
              <span className="font-mono">{OFFER_PLACEHOLDER}</span> where the
              offer sentence should go.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="pv-btn-ghost"
              onClick={() => setImportOpen((v) => !v)}
            >
              Bulk paste
            </button>
            <button
              type="button"
              className="pv-btn-ghost"
              disabled={templates.length === 0}
              onClick={async () => {
                if (await copyToClipboard(joinTemplates(templates))) {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }
              }}
            >
              {copied ? <CheckIcon size={15} /> : <CopyIcon size={15} />}
              {copied ? "Copied" : "Copy all"}
            </button>
            <button type="button" className="pv-btn-ghost" onClick={add}>
              Add template
            </button>
            <button
              type="button"
              className="pv-btn-primary disabled:opacity-50"
              disabled={!dirty || saving}
              onClick={onSave}
            >
              {saving ? <Spinner /> : null}
              {dirty ? "Save" : "Saved"}
            </button>
          </div>
        </div>

        {missingPlaceholder > 0 && (
          <p className="mt-3 flex gap-1.5 text-xs text-warning">
            <AlertIcon size={13} className="mt-0.5 shrink-0" />
            <span>
              {missingPlaceholder} template
              {missingPlaceholder === 1 ? " has" : "s have"} no{" "}
              <span className="font-mono">{OFFER_PLACEHOLDER}</span> placeholder
              — nothing will be substituted in {missingPlaceholder === 1 ? "it" : "them"}.
            </span>
          </p>
        )}

        {importOpen && (
          <div className="mt-4 rounded-xl border border-border p-3">
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              Paste templates separated by a line containing only{" "}
              <span className="font-mono">{TEMPLATE_SEPARATOR}</span>
            </label>
            <textarea
              className="pv-input pv-scroll resize-y font-mono text-xs leading-5"
              rows={10}
              value={importRaw}
              onChange={(e) => setImportRaw(e.target.value)}
              spellCheck={false}
            />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {splitTemplates(importRaw).length} found
              </span>
              <button
                type="button"
                className="pv-btn-ghost"
                disabled={splitTemplates(importRaw).length === 0}
                onClick={() => runImport("append")}
              >
                Add to library
              </button>
              <button
                type="button"
                className="pv-btn-ghost text-danger"
                disabled={splitTemplates(importRaw).length === 0}
                onClick={() => runImport("replace")}
              >
                Replace library
              </button>
              <button
                type="button"
                className="pv-btn-ghost"
                onClick={() => {
                  setImportOpen(false);
                  setImportRaw("");
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {templates.length === 0 ? (
        <div className="pv-card px-6 py-12 text-center">
          <h3 className="text-base font-semibold">No templates</h3>
          <p className="mx-auto mt-1.5 max-w-sm text-sm text-muted-foreground">
            Add one, or bulk-paste a list separated by{" "}
            <span className="font-mono">{TEMPLATE_SEPARATOR}</span> lines.
          </p>
        </div>
      ) : (
        templates.map((t, i) => (
          <div key={t.id} className="pv-card p-4 sm:p-5">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground">
                  {i + 1}
                </span>
                {t.body.trim() && !hasPlaceholder(t.body) && (
                  <span className="text-xs text-warning">no placeholder</span>
                )}
              </div>
              <button
                type="button"
                className="pv-btn-ghost text-danger"
                onClick={() => remove(t.id)}
                aria-label={`Delete template ${i + 1}`}
              >
                <TrashIcon size={15} />
                Delete
              </button>
            </div>
            <textarea
              className="pv-input pv-scroll resize-y font-mono text-xs leading-5"
              rows={10}
              value={t.body}
              placeholder={`Follow-up copy. Use ${OFFER_PLACEHOLDER} where the offer goes.`}
              onChange={(e) => update(t.id, e.target.value)}
              spellCheck={false}
            />
          </div>
        ))
      )}

      {templates.length > 0 && (
        <button type="button" className="pv-btn-ghost" onClick={add}>
          Add template
        </button>
      )}
    </div>
  );
}

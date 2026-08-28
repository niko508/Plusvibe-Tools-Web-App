"use client";

import { useState } from "react";
import {
  PARENT_SCHEDULE,
  SUBSEQUENCE_SCHEDULE,
  SUBSEQUENCES,
  SENDING_TAG_NAME,
  STEP_ONE_BODY,
  SUBJECT_PLACEHOLDER,
  UNSETTABLE_PARENT_SETTINGS,
  allSpecLabels,
} from "@/lib/first-campaign/blueprint";

// What the run will build, shown before it runs.
//
// The tool creates a lot in one click — a campaign, seven labels and six
// sub-sequences — so it's worth being able to read exactly what's coming
// without opening the code or trusting memory.

const DAY_NAMES = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function describeDays(days: Record<string, boolean>): string {
  return Object.keys(days)
    .map(Number)
    .sort((a, b) => a - b)
    .map((n) => DAY_NAMES[n])
    .join(", ");
}

export function Blueprint() {
  const [open, setOpen] = useState(false);
  const labels = allSpecLabels();

  return (
    <div className="mt-4 border-t border-border pt-3">
      <button
        type="button"
        className="text-xs text-muted-foreground underline"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "Hide what gets built" : "What gets built?"}
      </button>

      {open && (
        <div className="mt-3 space-y-4 text-xs">
          <section>
            <h3 className="font-medium">Step 1</h3>
            <p className="mt-1 text-muted-foreground">
              Subject and body are left as placeholders (
              <code>{SUBJECT_PLACEHOLDER}</code> and <code>{"{{BODY_COPY}}"}</code>
              ) for the copy to drop in. One variation, A.
            </p>
            <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/40 p-2.5 font-mono text-[11px] leading-relaxed">
              {STEP_ONE_BODY}
            </pre>
          </section>

          <section>
            <h3 className="font-medium">Schedule &amp; sending</h3>
            <ul className="mt-1 space-y-0.5 text-muted-foreground">
              <li>
                Campaign: {describeDays(PARENT_SCHEDULE.days)} ·{" "}
                {PARENT_SCHEDULE.timing.from}–{PARENT_SCHEDULE.timing.to} ·{" "}
                {PARENT_SCHEDULE.timezone} · {PARENT_SCHEDULE.daily_limit}/day,
                no new-lead cap
              </li>
              <li>
                Sub-sequences: {describeDays(SUBSEQUENCE_SCHEDULE.days)} ·{" "}
                {SUBSEQUENCE_SCHEDULE.timing.from}–
                {SUBSEQUENCE_SCHEDULE.timing.to} · sender limits ignored
              </li>
              <li>
                Sending accounts: the <strong>{SENDING_TAG_NAME}</strong> tag, so
                the senders follow the tag rather than freezing today&apos;s list
              </li>
              <li>
                Balanced 50/50 · Round Robin · plain text · risky emails on ·
                stop on reply · continue after OOO (AI, +15 days) · 2 leads per
                recipient domain per day
              </li>
            </ul>
          </section>

          <section>
            <h3 className="font-medium">
              {SUBSEQUENCES.length} sub-sequences, {labels.length} lead labels
            </h3>
            <ul className="mt-1 space-y-0.5 text-muted-foreground">
              {SUBSEQUENCES.map((s) => (
                <li key={s.name}>
                  <span className="text-foreground">{s.name}</span> ←{" "}
                  {s.labels.map((l) => l.name).join(" or ")}
                  {s.content ? (
                    <>
                      {" "}
                      ·{" "}
                      {s.content.steps.length} step
                      {s.content.steps.length === 1 ? "" : "s"}, first after{" "}
                      {s.content.firstWaitDays} day
                      {s.content.firstWaitDays === 1 ? "" : "s"}
                      {s.content.steps.length > 1 &&
                        `, then ${s.content.steps[0].waitDays} more`}
                    </>
                  ) : (
                    <span className="text-warning"> · no emails yet</span>
                  )}
                </li>
              ))}
            </ul>
            <p className="mt-1.5 text-muted-foreground">
              Every sub-sequence step has an empty subject, so it lands as a
              reply on the lead&apos;s existing thread. Labels the workspace
              doesn&apos;t have yet are created first; ones it already has are
              reused, whatever their spelling.
            </p>
          </section>

          <section>
            <h3 className="font-medium">Not set by the API</h3>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted-foreground">
              {UNSETTABLE_PARENT_SETTINGS.map((f) => (
                <li key={f}>{f}</li>
              ))}
              <li>
                Sub-sequence &quot;last used sender account&quot; and CC — no
                fields exist for them
              </li>
              <li>Sub-sequence email content — added separately</li>
            </ul>
          </section>
        </div>
      )}
    </div>
  );
}

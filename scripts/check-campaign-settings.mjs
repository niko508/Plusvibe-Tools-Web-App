// Unit checks for Change Campaign Settings: reading the API's mixed forms,
// validating changes, the per-campaign diff, the PATCH body and the read-back
// check. Imports the REAL module.
//
//   node scripts/check-campaign-settings.mjs

import { importTs } from "./ts-loader.mjs";

let failures = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) console.log(`PASS  ${label}`);
  else {
    failures++;
    console.log(`FAIL  ${label}\n   got  ${JSON.stringify(got)}\n   want ${JSON.stringify(want)}`);
  }
};

const m = await importTs("@/lib/campaign-settings/settings");
const { SETTINGS, specFor, readValue, validateChange, prepareChanges, diffCampaign, patchBody, unverified, describeChanges, IN_SCOPE_STATUSES } = m;
const esp = specFor("is_esp_match");
const varSel = specFor("var_sel_type");
const maxLead = specFor("max_lead_domain_per_day");

// --- reading what the API reports ------------------------------------------------
eq("ESP matching is in the catalogue as a toggle", esp?.kind, "toggle");
eq("a toggle read as 1 is yes", readValue(esp, 1), "yes");
eq("…as 0 is no", readValue(esp, 0), "no");
eq("…as 'yes' is yes", readValue(esp, "yes"), "yes");
eq("…as true is yes", readValue(esp, true), "yes");
eq("…as '0' is no", readValue(esp, "0"), "no");
eq("…missing is null", readValue(esp, undefined), null);
eq("…garbage is null", readValue(esp, "maybe"), null);
eq("a choice reads as its string", readValue(varSel, "R_ROBIN"), "R_ROBIN");
eq("a number reads as a number, even from a string", readValue(maxLead, "2"), 2);
eq("a non-number is null", readValue(maxLead, "two"), null);

// --- validation ------------------------------------------------------------------------
eq("toggle on is fine", validateChange({ key: "is_esp_match", value: "yes" }), []);
eq("toggle must be yes/no", validateChange({ key: "is_esp_match", value: "on" }), ["ESP matching: choose On or Off."]);
eq("unknown setting is refused", validateChange({ key: "status", value: "ACTIVE" }), ['"status" is not a setting this tool can change.']);
eq("choice must be one of the options", validateChange({ key: "var_sel_type", value: "RANDOM" }), ["Follow-up variation selection: pick one of the options."]);
eq("number below the minimum is refused", validateChange({ key: "max_lead_domain_per_day", value: 0 }), ["Max leads per domain per day: must be at least 1."]);
eq("a blank number is refused", validateChange({ key: "opportunity_val", value: "" }).length, 1);
eq("a number as a string is fine", validateChange({ key: "opportunity_val", value: "250" }), []);

const prep = prepareChanges([
  { key: "stop_on_lead_replied", value: "no" },
  { key: "is_esp_match", value: "no" },
  { key: "is_esp_match", value: "yes" }, // the later one wins
  { key: "opportunity_val", value: "250" },
  { key: "bogus", value: "x" },
]);
eq("changes come out in catalogue order, one per setting, numbers as numbers", prep.changes, [
  { key: "is_esp_match", value: "yes" },
  { key: "stop_on_lead_replied", value: "no" },
  { key: "opportunity_val", value: 250 },
]);
eq("…with the bad one reported", prep.problems, ['"bogus" is not a setting this tool can change.']);
eq("nothing picked → nothing", prepareChanges([]), { changes: [], problems: [] });

// --- the per-campaign diff ------------------------------------------------------------------
const WANT = [{ key: "is_esp_match", value: "yes" }, { key: "stop_on_lead_replied", value: "yes" }];
eq("a campaign with ESP off needs ESP only", diffCampaign(WANT, { is_esp_match: 0, stop_on_lead_replied: 1 }), [{ key: "is_esp_match", value: "yes" }]);
eq("a campaign already set needs nothing", diffCampaign(WANT, { is_esp_match: "yes", stop_on_lead_replied: true }), []);
eq("a campaign that doesn't report a setting gets it written", diffCampaign(WANT, { stop_on_lead_replied: 1 }), [{ key: "is_esp_match", value: "yes" }]);
eq("a number is compared as a number", diffCampaign([{ key: "opportunity_val", value: 250 }], { opportunity_val: "250" }), []);

// --- the write and the read-back --------------------------------------------------------------
eq("the PATCH body carries ids and only the needed settings", patchBody("ws1", "c1", [{ key: "is_esp_match", value: "yes" }]), { workspace_id: "ws1", campaign_id: "c1", is_esp_match: "yes" });
eq("read-back confirms when the API reports 1", unverified([{ key: "is_esp_match", value: "yes" }], { is_esp_match: 1 }), []);
eq("read-back flags a value that didn't stick", unverified([{ key: "is_esp_match", value: "yes" }], { is_esp_match: 0 }).map((c) => c.key), ["is_esp_match"]);

// --- labels and scope ---------------------------------------------------------------------------
eq("the label reads as the changes", describeChanges(prep.changes), "ESP matching → On, Stop on reply → Off, Opportunity value → $250");
eq("a choice is labelled", describeChanges([{ key: "var_sel_type", value: "INIT_STEP_VAR" }]), "Follow-up variation selection → Match initial variation");
eq("a percentage is labelled", describeChanges([{ key: "bounce_rate_limit", value: 5 }]), "Bounce rate limit → 5%");
eq("only ACTIVE campaigns are in scope", [...IN_SCOPE_STATUSES], ["ACTIVE"]);
eq("every catalogue key is unique", new Set(SETTINGS.map((s) => s.key)).size, SETTINGS.length);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

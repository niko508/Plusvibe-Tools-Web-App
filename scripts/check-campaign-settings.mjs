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
const { SETTINGS, specFor, readValue, validateChange, prepareChanges, diffCampaign, patchBody, unverified, describeChanges, IN_SCOPE_STATUSES, RATIO_PRESETS, wireValue, describeRatio } = m;
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

// --- Sending Preference -------------------------------------------------------
// The tool works in the new-leads percentage, the way Plusvibe's own screen
// reads it. The API takes `send_priority`: the FOLLOW-UP share, 0 to 1.
console.log("--- sending preference");
const pref = specFor("send_priority");
eq("it is in the catalogue as a ratio", pref?.kind, "ratio");
eq("Plusvibe's own presets are offered", RATIO_PRESETS.map((p) => p.newLeads), [100, 70, 50, 30, 0]);
eq("…named as Plusvibe names them", RATIO_PRESETS.map((p) => p.label), [
  "All New (100/0)", "Growth (70/30)", "Balanced (50/50)", "Retention (30/70)", "All Follow-ups (0/100)",
]);

eq("70/30 goes out as a 0.3 follow-up share", wireValue(pref, 70), 0.3);
eq("all new goes out as 0", wireValue(pref, 100), 0);
eq("all follow-ups goes out as 1", wireValue(pref, 0), 1);
eq("balanced goes out as 0.5", wireValue(pref, 50), 0.5);
eq("an odd split still lands on two decimals", wireValue(pref, 65), 0.35);
eq("a setting that is not a ratio is written as it is", wireValue(specFor("bounce_rate_limit"), 5), 5);

eq("0.3 reads back as 70% new", readValue(pref, 0.3), 70);
eq("…0 as all new", readValue(pref, 0), 100);
eq("…1 as all follow-ups", readValue(pref, 1), 0);
eq("…a string is read too", readValue(pref, "0.5"), 50);
eq("…and nothing reported is null", readValue(pref, undefined), null);
// A value outside 0–1 is not a share this build understands; guessing at it
// would silently write the wrong split.
eq("a value out of range is not guessed at", [readValue(pref, 30), readValue(pref, -1), readValue(pref, "x")], [null, null, null]);

eq("a whole percentage is accepted", validateChange({ key: "send_priority", value: 70 }), []);
eq("…the ends too", [validateChange({ key: "send_priority", value: 0 }).length, validateChange({ key: "send_priority", value: 100 }).length], [0, 0]);
eq("over 100 is refused", validateChange({ key: "send_priority", value: 101 }), ["Sending preference: must be between 0 and 100."]);
eq("below 0 is refused", validateChange({ key: "send_priority", value: -1 }), ["Sending preference: must be between 0 and 100."]);
eq("a fraction of a percent is refused", validateChange({ key: "send_priority", value: 70.5 }), ["Sending preference: use a whole percentage."]);
eq("a blank is refused", validateChange({ key: "send_priority", value: "" }), ["Sending preference: enter a percentage."]);

// The diff and the read-back both work in percentages, so a campaign already
// on 70/30 is counted rather than written.
eq("a campaign already on 70/30 needs no write",
  diffCampaign([{ key: "send_priority", value: 70 }], { send_priority: 0.3 }), []);
eq("…one on 50/50 does",
  diffCampaign([{ key: "send_priority", value: 70 }], { send_priority: 0.5 }).map((c) => c.value), [70]);
eq("…and one that doesn't report it does",
  diffCampaign([{ key: "send_priority", value: 70 }], {}).length, 1);
eq("the PATCH body carries the wire form",
  patchBody("w1", "c1", prepareChanges([{ key: "send_priority", value: 70 }]).changes),
  { workspace_id: "w1", campaign_id: "c1", send_priority: 0.3 });
eq("the read-back confirms it", unverified([{ key: "send_priority", value: 70 }], { send_priority: 0.3 }), []);
eq("…and catches a write that didn't land",
  unverified([{ key: "send_priority", value: 70 }], { send_priority: 0.5 }).length, 1);

eq("a preset is named in the label", describeChanges([{ key: "send_priority", value: 70 }]), "Sending preference → Growth (70/30)");
eq("…and an odd split is spelled out", describeChanges([{ key: "send_priority", value: 65 }]), "Sending preference → 65% new / 35% follow-ups");
eq("every preset round-trips through the wire", RATIO_PRESETS.every((p) => readValue(pref, wireValue(pref, p.newLeads)) === p.newLeads), true);
eq("…as does every whole percentage", Array.from({ length: 101 }, (_, i) => i).every((n) => readValue(pref, wireValue(pref, n)) === n), true);
eq("describeRatio names the presets", describeRatio(30), "Retention (30/70)");

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

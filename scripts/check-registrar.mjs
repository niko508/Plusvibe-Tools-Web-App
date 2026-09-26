// Unit checks for the registrar fallback on Blocked Domains: reading the
// registrar out of an RDAP answer, and naming it the way the app names
// platforms. Imports the REAL module.
//
//   node scripts/check-registrar.mjs

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

const { registrarFromRdap, platformLabel } = await importTs("@/lib/blocked-domains/registrar");

const vcard = (fn) => ["vcard", [["version", {}, "text", "4.0"], ["fn", {}, "text", fn]]];

console.log("--- the registrar, out of an RDAP answer");
// Shaped like the .org registry's answer for gronda.org.
eq("the registrar entity's name",
  registrarFromRdap({
    objectClassName: "domain",
    ldhName: "gronda.org",
    entities: [
      { roles: ["registrant"], vcardArray: vcard("REDACTED FOR PRIVACY") },
      { roles: ["registrar"], vcardArray: vcard("Porkbun LLC"), entities: [{ roles: ["abuse"], vcardArray: vcard("Abuse") }] },
    ],
  }),
  "Porkbun LLC");
eq("…found when it sits one level down", registrarFromRdap({ entities: [{ roles: ["technical"], entities: [{ roles: ["registrar"], vcardArray: vcard("Dynadot Inc") }] }] }), "Dynadot Inc");
eq("…not a contact that merely has a name", registrarFromRdap({ entities: [{ roles: ["registrant"], vcardArray: vcard("Someone") }] }), null);
eq("…and null for anything else", [registrarFromRdap(null), registrarFromRdap({}), registrarFromRdap({ entities: "x" })], [null, null, null]);

console.log("--- named the way the app names platforms");
eq("the four platforms the app tags by", ["Porkbun LLC", "Dynadot Inc", "NameSilo, LLC", "Spaceship, Inc."].map(platformLabel), ["porkbun", "dynadot", "namesilo", "spaceship"]);
eq("any other registrar, without the company suffix", ["NameCheap, Inc.", "GoDaddy.com, LLC", "Tucows Domains Inc.", "Cloudflare, Inc"].map(platformLabel), ["NameCheap", "GoDaddy.com", "Tucows Domains", "Cloudflare"]);
eq("…and a bare name as it is", platformLabel("Gandi SAS"), "Gandi SAS");

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);

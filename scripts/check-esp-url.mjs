// Unit checks for reading the ESP app's address out of ESP_APP_URL.
import { importTs } from "./ts-loader.mjs";

let failures = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`}`);
};

const { cleanEspUrl } = await importTs("@/lib/esp-url");
const U = "https://plusvibe-esp-matching-campaign-limits-change-production.up.railway.app";
eq("the address as it should be", cleanEspUrl(U), U);
eq("a trailing slash", cleanEspUrl(`${U}/`), U);
eq("the whole NAME=value line pasted as the value, with a path", cleanEspUrl(`ESP_APP_URL=${U}/api/run`), U);
eq("in quotes, with spaces", cleanEspUrl(` ESP_APP_URL = '${U}' `), U);
eq("without https://", cleanEspUrl("plusvibe-esp-matching-campaign-limits-change-production.up.railway.app"), U);
eq("a local address keeps its port", cleanEspUrl("http://localhost:4771/"), "http://localhost:4771");
eq("unset", cleanEspUrl(undefined), "");
eq("not an address", cleanEspUrl("not a url"), "");

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);

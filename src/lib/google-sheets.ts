import "server-only";

import { createSign } from "crypto";

// Minimal Google Sheets API client authenticated with a service account.
//
// Reading elsewhere in the app goes through the public gviz CSV export, which
// needs no credentials — but writing does. Rather than pull in `googleapis`
// (large, and we need three calls), this signs a JWT with the service account
// key and exchanges it for an access token, exactly as the OAuth2 service
// account flow prescribes.
//
// Setup: create a service account, download its JSON key, share the target
// sheet with the service account's client_email (Editor), and set the whole
// JSON as GOOGLE_SERVICE_ACCOUNT_JSON.

// Overridable so a stand-in can serve Google's endpoints in tests; production
// never sets either, and both default to the real thing.
const TOKEN_URL = process.env.GOOGLE_TOKEN_URL || "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const SHEETS_API =
  process.env.GOOGLE_SHEETS_API_URL || "https://sheets.googleapis.com/v4/spreadsheets";

export class GoogleSheetsError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.name = "GoogleSheetsError";
    this.status = status;
  }
}

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

function loadCredentials(): ServiceAccount {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  if (!raw) {
    throw new GoogleSheetsError(
      "Google Sheets writing isn't configured — set GOOGLE_SERVICE_ACCOUNT_JSON and share the sheet with the service account.",
      501
    );
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new GoogleSheetsError(
      "GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON — paste the whole downloaded key file.",
      500
    );
  }
  const client_email = String(parsed.client_email ?? "");
  // Env vars usually carry the key with literal \n rather than real newlines.
  const private_key = String(parsed.private_key ?? "").replace(/\\n/g, "\n");
  if (!client_email || !private_key) {
    throw new GoogleSheetsError(
      "GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email or private_key.",
      500
    );
  }
  return { client_email, private_key };
}

/** The account the sheet must be shared with — surfaced in setup errors. */
export function serviceAccountEmail(): string | null {
  try {
    return loadCredentials().client_email;
  } catch {
    return null;
  }
}

export function isSheetWritingConfigured(): boolean {
  return !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  // Refresh a minute early so a token can't expire mid-request.
  if (cachedToken && cachedToken.expiresAt - 60_000 > Date.now()) {
    return cachedToken.token;
  }
  const creds = loadCredentials();
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: creds.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      exp: now + 3600,
      iat: now,
    })
  );
  let assertion: string;
  try {
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${claims}`);
    assertion = `${header}.${claims}.${b64url(signer.sign(creds.private_key))}`;
  } catch {
    throw new GoogleSheetsError(
      "Could not sign with the service account private key — check the key wasn't mangled when it was pasted into the env var.",
      500
    );
  }

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
    cache: "no-store",
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error_description?: string;
    error?: string;
  };
  if (!res.ok || !body.access_token) {
    throw new GoogleSheetsError(
      `Google rejected the service account: ${body.error_description ?? body.error ?? res.status}`,
      502
    );
  }
  cachedToken = {
    token: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  };
  return cachedToken.token;
}

async function sheetsFetch<T>(
  path: string,
  init?: { method?: string; body?: unknown }
): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(`${SHEETS_API}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      ...(init?.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!res.ok) {
    const msg =
      (parsed as { error?: { message?: string } })?.error?.message ??
      `Sheets API request failed (${res.status})`;
    const hint =
      res.status === 403
        ? ` — share the sheet with ${serviceAccountEmail() ?? "the service account"} as an Editor.`
        : "";
    throw new GoogleSheetsError(`${msg}${hint}`, res.status);
  }
  return parsed as T;
}

/** A1 notation needs single quotes around tab names with spaces or emoji. */
export function quoteTab(tab: string): string {
  return `'${tab.replace(/'/g, "''")}'`;
}

/** Reads a whole tab as a grid of strings (missing cells become ""). */
export async function readTab(
  spreadsheetId: string,
  tab: string
): Promise<string[][]> {
  const range = encodeURIComponent(`${quoteTab(tab)}`);
  const data = await sheetsFetch<{ values?: string[][] }>(
    `/${spreadsheetId}/values/${range}?majorDimension=ROWS`
  );
  return (data.values ?? []).map((row) => row.map((c) => String(c ?? "")));
}

export interface CellUpdate {
  /** Full A1 range including the tab, e.g. `'📋 Domains'!C5` */
  range: string;
  value: string;
}

/**
 * Writes individual cells in one batch call.
 *
 * `RAW` stores text exactly as given — right for emails and status labels, and
 * it can't accidentally turn a value into a formula. `USER_ENTERED` makes
 * Sheets parse the value the way typing it would, which is required for dates
 * to become real dates and for formulas to evaluate rather than sit there as
 * text.
 */
export async function batchUpdateCells(
  spreadsheetId: string,
  updates: CellUpdate[],
  valueInputOption: "RAW" | "USER_ENTERED" = "RAW"
): Promise<number> {
  if (updates.length === 0) return 0;
  const res = await sheetsFetch<{ totalUpdatedCells?: number }>(
    `/${spreadsheetId}/values:batchUpdate`,
    {
      method: "POST",
      body: {
        valueInputOption,
        data: updates.map((u) => ({
          range: u.range,
          majorDimension: "ROWS",
          values: [[u.value]],
        })),
      },
    }
  );
  return res.totalUpdatedCells ?? 0;
}

/** 0-based column index to an A1 letter (0 -> A, 26 -> AA). */
export function columnLetter(index: number): string {
  let n = index;
  let out = "";
  while (n >= 0) {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  }
  return out;
}

/**
 * Appends a row to the end of a tab.
 *
 * Uses Sheets' own append, which finds the first empty row itself — reading the
 * grid and writing to `length + 1` would race any other writer and silently
 * overwrite whatever landed in between. `INSERT_ROWS` keeps it from consuming
 * a row that already has data below the table.
 */
export async function appendRow(
  spreadsheetId: string,
  tab: string,
  values: string[]
): Promise<void> {
  await appendRows(spreadsheetId, tab, [values]);
}

/**
 * Appends several rows in one call. Sheets accepts a whole block in one
 * append, so a domain with fifty burned inboxes costs one request, not fifty.
 */
export async function appendRows(
  spreadsheetId: string,
  tab: string,
  rows: string[][]
): Promise<void> {
  if (rows.length === 0) return;
  const range = encodeURIComponent(quoteTab(tab));
  await sheetsFetch(
    `/${spreadsheetId}/values/${range}:append` +
      `?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { method: "POST", body: { values: rows } }
  );
}

/**
 * The spreadsheet the unattended automations write to.
 *
 * The interactive tools take the sheet URL from the browser, but a webhook has
 * no browser — so the id comes from the environment. Accepts a full URL as well
 * as a bare id, since it's easy to paste the wrong one into Railway.
 */
export function envSpreadsheetId(): string | null {
  const raw = process.env.SPREADSHEET_ID?.trim();
  if (!raw) return null;
  const fromUrl = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/.exec(raw);
  const id = fromUrl ? fromUrl[1] : raw;
  return /^[a-zA-Z0-9-_]{20,}$/.test(id) ? id : null;
}

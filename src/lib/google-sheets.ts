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

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";

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

/** Writes individual cells in one batch call. */
export async function batchUpdateCells(
  spreadsheetId: string,
  updates: CellUpdate[]
): Promise<number> {
  if (updates.length === 0) return 0;
  const res = await sheetsFetch<{ totalUpdatedCells?: number }>(
    `/${spreadsheetId}/values:batchUpdate`,
    {
      method: "POST",
      body: {
        valueInputOption: "RAW",
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

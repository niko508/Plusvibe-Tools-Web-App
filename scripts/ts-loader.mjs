// Lets the check scripts import the project's real TypeScript modules.
//
// The older checks mirror the logic they test by hand, which means they can
// pass while the module they describe is broken — the copy is what gets
// exercised, not the code that ships. This loader removes that gap for new
// checks: it strips the types with sucrase and resolves the `@/…` alias, so a
// check imports the same file Next.js builds.
//
// Only for pure modules. Anything importing `server-only`, React, or Node
// built-ins with side effects should still be tested through its own seam.

import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { transform } from "sucrase";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");

/** Resolves "@/lib/x" and relative specifiers to an absolute .ts path. */
function resolveSpecifier(specifier, fromFile) {
  let base;
  if (specifier.startsWith("@/")) {
    base = path.join(SRC, specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    base = path.resolve(path.dirname(fromFile), specifier);
  } else {
    return null; // bare import — leave it to Node
  }
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
  ]) {
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      // try the next shape
    }
  }
  throw new Error(`Cannot resolve "${specifier}" from ${fromFile}`);
}

const cache = new Map();

/**
 * Imports a TypeScript module by path (absolute, or "@/…"), transpiling it and
 * its local dependencies to data: URLs.
 */
export async function importTs(specifier, fromFile = path.join(SRC, "index.ts")) {
  const file = resolveSpecifier(specifier, fromFile);
  if (!file) return import(specifier);
  if (cache.has(file)) return cache.get(file);

  const source = readFileSync(file, "utf8");
  const { code } = transform(source, {
    transforms: ["typescript"],
    filePath: file,
  });

  // Rewrite each local import to a data: URL for the already-loaded dependency,
  // so the module graph is wired up without touching Node's resolver.
  const importRe = /(from\s+|import\s+)["']([^"']+)["']/g;
  const deps = new Map();
  for (const match of source.matchAll(importRe)) {
    const spec = match[2];
    if (!spec.startsWith("@/") && !spec.startsWith(".")) continue;
    if (deps.has(spec)) continue;
    const mod = await importTs(spec, file);
    deps.set(spec, mod);
  }

  // Type-only imports vanish in the transpiled output, so only rewrite what
  // survived; the rest would be a dangling specifier.
  let out = code;
  const stubs = [];
  let i = 0;
  for (const [spec, mod] of deps) {
    if (!out.includes(`"${spec}"`) && !out.includes(`'${spec}'`)) continue;
    const name = `__dep${i++}`;
    globalThis[name] = mod;
    const stub = `data:text/javascript,${encodeURIComponent(
      `const m = globalThis[${JSON.stringify(name)}];` +
        `export default m.default;` +
        Object.keys(mod)
          .filter((k) => k !== "default")
          .map((k) => `export const ${k} = m[${JSON.stringify(k)}];`)
          .join("")
    )}`;
    stubs.push(stub);
    out = out.split(`"${spec}"`).join(`"${stub}"`).split(`'${spec}'`).join(`'${stub}'`);
  }

  const url = `data:text/javascript;base64,${Buffer.from(out).toString("base64")}`;
  const loaded = await import(url);
  cache.set(file, loaded);
  return loaded;
}

export { ROOT, SRC, pathToFileURL };

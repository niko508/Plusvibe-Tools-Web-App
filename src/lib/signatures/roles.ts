// The default pool of signature job titles, and the random pick the title
// slots start with. No React here, so the server can use it too.

export const DEFAULT_ROLES = [
  "Account Executive",
  "Key Account Executive",
  "Growth Manager",
  "Business Development",
  "Head of Growth",
  "Growth Director",
  "Growth Lead",
  "Head of Business Development",
  "BDR Manager",
  "BDR",
  "Business Development Representative",
  "Partnerships Manager",
];

export function pickRandomRoles(n: number): string[] {
  const pool = [...DEFAULT_ROLES];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const picked = pool.slice(0, n);
  while (picked.length < n) picked.push("");
  return picked;
}


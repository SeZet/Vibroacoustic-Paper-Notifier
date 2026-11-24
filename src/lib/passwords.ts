import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { ensureSchema, sql } from "./db";

/**
 * The site has two passwords: one for the whole site (shared by the group) and
 * one for the API cost page. Each is stored as a salted scrypt hash in the
 * meta table; until someone changes it, the default applies.
 */
export const PASSWORDS = {
  site: { metaKey: "site_password", fallback: "VA-DLR", cookie: "site_auth", cookiePath: "/" },
  cost: { metaKey: "cost_password", fallback: "admin", cookie: "cost_auth", cookiePath: "/costs" },
} as const;

export type PasswordKind = keyof typeof PASSWORDS;

export const MIN_PASSWORD_LENGTH = 4;

/** The stored hash, or null while the default password is still in use. */
async function storedHash(kind: PasswordKind): Promise<string | null> {
  await ensureSchema();
  const rows = await sql`SELECT value FROM meta WHERE key = ${PASSWORDS[kind].metaKey}`;
  return rows[0] ? String(rows[0].value) : null;
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function checkPassword(kind: PasswordKind, password: string): Promise<boolean> {
  const stored = await storedHash(kind);
  if (!stored) return safeEqual(Buffer.from(password), Buffer.from(PASSWORDS[kind].fallback));
  const [salt, hash] = stored.split(":");
  return safeEqual(scryptSync(password, salt, 32), Buffer.from(hash, "hex"));
}

export async function setPassword(kind: PasswordKind, password: string) {
  const salt = randomBytes(16).toString("hex");
  const value = `${salt}:${scryptSync(password, salt, 32).toString("hex")}`;
  await ensureSchema();
  await sql`INSERT INTO meta (key, value) VALUES (${PASSWORDS[kind].metaKey}, ${value})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
}

export async function usingDefaultPassword(kind: PasswordKind): Promise<boolean> {
  return (await storedHash(kind)) === null;
}

/**
 * Value of the login cookie. It is derived from the current password hash, so
 * changing a password signs everyone out who used the old one.
 */
export async function authToken(kind: PasswordKind): Promise<string> {
  const stored = (await storedHash(kind)) ?? `default:${PASSWORDS[kind].fallback}`;
  const secret = process.env.CRON_SECRET ?? "";
  return createHash("sha256").update(`${kind}|${secret}|${stored}`).digest("hex");
}

export async function isAuthorized(kind: PasswordKind, cookieValue: string | undefined): Promise<boolean> {
  if (!cookieValue) return false;
  return safeEqual(Buffer.from(cookieValue), Buffer.from(await authToken(kind)));
}

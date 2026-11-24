"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ensureSchema, sql, type Person, type RecStatus } from "./db";
import { runScans } from "./scan";
import { resetCostTotal } from "./costs";
import {
  authToken,
  checkPassword,
  isAuthorized,
  MIN_PASSWORD_LENGTH,
  PASSWORDS,
  setPassword,
  type PasswordKind,
} from "./passwords";

export async function savePerson(formData: FormData) {
  await ensureSchema();
  const id = Number(formData.get("id"));
  const slug = String(formData.get("slug") ?? "");
  const interests = String(formData.get("interests") ?? "").slice(0, 10_000);
  const frequency = formData.get("frequency") === "monthly" ? "monthly" : "weekly";
  await sql`UPDATE people SET interests = ${interests}, frequency = ${frequency} WHERE id = ${id}`;
  revalidatePath("/");
  revalidatePath(`/${slug}`);
}

/** Moves a paper between the Recommended ("new"), Saved and Deleted lists. */
export async function setRecommendationStatus(formData: FormData) {
  await ensureSchema();
  const id = Number(formData.get("id"));
  const slug = String(formData.get("slug") ?? "");
  const raw = String(formData.get("status"));
  const status: RecStatus = raw === "saved" || raw === "deleted" ? raw : "new";
  // Deleted papers stay in the database so the same paper is never suggested again.
  await sql`UPDATE recommendations SET status = ${status}, status_changed_at = now() WHERE id = ${id}`;
  revalidatePath("/");
  revalidatePath(`/${slug}`);
}

export async function scanNow(formData: FormData) {
  await ensureSchema();
  const id = Number(formData.get("id"));
  const slug = String(formData.get("slug") ?? "");
  const rows = await sql`SELECT * FROM people WHERE id = ${id}`;
  const person = rows[0] as unknown as Person | undefined;
  if (!person) return;
  await runScans([person], { timeBudgetMs: 240_000 });
  revalidatePath("/");
  revalidatePath(`/${slug}`);
}

function venueFields(formData: FormData) {
  const kind = formData.get("kind") === "arxiv" ? "arxiv" : "journal";
  const name = String(formData.get("name") ?? "").trim();
  const issns = kind === "arxiv" ? "" : String(formData.get("issns") ?? "").trim();
  const matchText = String(formData.get("match_text") ?? "").trim();
  let feedUrl = kind === "arxiv" ? "" : String(formData.get("feed_url") ?? "").trim();
  if (feedUrl && !/^https?:\/\//i.test(feedUrl)) feedUrl = "";
  const valid = Boolean(name && (issns || matchText));
  return { kind, name, issns, matchText, feedUrl, valid };
}

export async function addVenue(formData: FormData) {
  await ensureSchema();
  const v = venueFields(formData);
  if (!v.valid) return;
  await sql`INSERT INTO venues (name, kind, issns, match_text, feed_url)
    VALUES (${v.name}, ${v.kind}, ${v.issns}, ${v.matchText}, ${v.feedUrl})`;
  revalidatePath("/venues");
}

export async function updateVenue(formData: FormData) {
  await ensureSchema();
  const id = Number(formData.get("id"));
  const v = venueFields(formData);
  if (!id || !v.valid) return;
  await sql`UPDATE venues SET name = ${v.name}, kind = ${v.kind}, issns = ${v.issns},
    match_text = ${v.matchText}, feed_url = ${v.feedUrl} WHERE id = ${id}`;
  revalidatePath("/venues");
}

export async function toggleVenue(formData: FormData) {
  await ensureSchema();
  const id = Number(formData.get("id"));
  await sql`UPDATE venues SET enabled = NOT enabled WHERE id = ${id}`;
  revalidatePath("/venues");
}

export async function deleteVenue(formData: FormData) {
  await ensureSchema();
  const id = Number(formData.get("id"));
  await sql`DELETE FROM venues WHERE id = ${id}`;
  revalidatePath("/venues");
}


// --- Passwords ---

async function signIn(kind: PasswordKind) {
  const jar = await cookies();
  jar.set(PASSWORDS[kind].cookie, await authToken(kind), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: PASSWORDS[kind].cookiePath,
    maxAge: 90 * 24 * 60 * 60,
  });
}

async function signOut(kind: PasswordKind) {
  const jar = await cookies();
  jar.delete({ name: PASSWORDS[kind].cookie, path: PASSWORDS[kind].cookiePath });
}

async function requireAuth(kind: PasswordKind, home: string) {
  const jar = await cookies();
  if (!(await isAuthorized(kind, jar.get(PASSWORDS[kind].cookie)?.value))) redirect(home);
}

/** Checks the form's current password and saves the new one; returns a status code for the page. */
async function changePassword(kind: PasswordKind, formData: FormData): Promise<string> {
  const current = String(formData.get("current") ?? "");
  const next = String(formData.get("next") ?? "");
  const repeat = String(formData.get("repeat") ?? "");
  if (!(await checkPassword(kind, current))) return "wrong";
  if (next.length < MIN_PASSWORD_LENGTH) return "short";
  if (next !== repeat) return "mismatch";
  await setPassword(kind, next);
  await signIn(kind); // the old cookie no longer matches the new password
  return "changed";
}

/** Only allow redirects to a path on this site. */
function safeNext(raw: FormDataEntryValue | null): string {
  const next = String(raw ?? "");
  return next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/";
}

// Whole site

export async function siteLogin(formData: FormData) {
  const next = safeNext(formData.get("next"));
  if (!(await checkPassword("site", String(formData.get("password") ?? "")))) {
    redirect(`/login?error=wrong&next=${encodeURIComponent(next)}`);
  }
  await signIn("site");
  redirect(next);
}

export async function siteLogout() {
  await signOut("site");
  await signOut("cost");
  redirect("/login");
}

export async function changeSitePassword(formData: FormData) {
  await requireAuth("site", "/login");
  redirect(`/access?pw=${await changePassword("site", formData)}`);
}

// API cost page

export async function costLogin(formData: FormData) {
  if (!(await checkPassword("cost", String(formData.get("password") ?? "")))) redirect("/costs?error=wrong");
  await signIn("cost");
  redirect("/costs");
}

export async function costLogout() {
  await signOut("cost");
  redirect("/costs");
}

export async function resetCosts() {
  await requireAuth("cost", "/costs");
  await resetCostTotal();
  revalidatePath("/costs");
}

export async function changeCostPassword(formData: FormData) {
  await requireAuth("cost", "/costs");
  redirect(`/costs?pw=${await changePassword("cost", formData)}`);
}

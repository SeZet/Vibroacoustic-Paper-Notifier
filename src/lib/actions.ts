"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ensureSchema, sql, type Person, type RecStatus } from "./db";
import { runScans } from "./scan";
import { authToken, checkPassword, COST_COOKIE, isAuthorized, resetCostTotal, setPassword } from "./costs";

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

export async function addVenue(formData: FormData) {
  await ensureSchema();
  const name = String(formData.get("name") ?? "").trim();
  const issns = String(formData.get("issns") ?? "").trim();
  const matchText = String(formData.get("match_text") ?? "").trim();
  if (!name || (!issns && !matchText)) return;
  await sql`INSERT INTO venues (name, issns, match_text) VALUES (${name}, ${issns}, ${matchText})`;
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


// --- API cost page ---

async function requireCostAuth() {
  const jar = await cookies();
  if (!(await isAuthorized(jar.get(COST_COOKIE)?.value))) redirect("/costs");
}

async function signIn() {
  const jar = await cookies();
  jar.set(COST_COOKIE, await authToken(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/costs",
    maxAge: 30 * 24 * 60 * 60,
  });
}

export async function costLogin(formData: FormData) {
  const password = String(formData.get("password") ?? "");
  if (!(await checkPassword(password))) redirect("/costs?error=wrong");
  await signIn();
  redirect("/costs");
}

export async function costLogout() {
  const jar = await cookies();
  jar.delete({ name: COST_COOKIE, path: "/costs" });
  redirect("/costs");
}

export async function resetCosts() {
  await requireCostAuth();
  await resetCostTotal();
  revalidatePath("/costs");
}

export async function changeCostPassword(formData: FormData) {
  await requireCostAuth();
  const current = String(formData.get("current") ?? "");
  const next = String(formData.get("next") ?? "");
  const repeat = String(formData.get("repeat") ?? "");
  if (!(await checkPassword(current))) redirect("/costs?pw=wrong");
  if (next.length < 4) redirect("/costs?pw=short");
  if (next !== repeat) redirect("/costs?pw=mismatch");
  await setPassword(next);
  await signIn(); // the old cookie no longer matches the new password
  redirect("/costs?pw=changed");
}

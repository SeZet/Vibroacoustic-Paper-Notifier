"use server";

import { revalidatePath } from "next/cache";
import { ensureSchema, sql, type Person, type RecStatus } from "./db";
import { runScans } from "./scan";

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


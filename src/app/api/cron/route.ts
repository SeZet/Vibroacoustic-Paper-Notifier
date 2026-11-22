import { NextResponse } from "next/server";
import { getPeople } from "@/lib/db";
import { isDue, runScans } from "@/lib/scan";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Called once a day by Vercel Cron (see vercel.json). Scans everyone whose weekly/monthly scan is due. */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const now = new Date();
  const people = await getPeople();
  const due = people.filter((p) => isDue(p, now));
  const results = await runScans(due, { timeBudgetMs: 200_000 });
  return NextResponse.json({ checked: people.length, scanned: results });
}

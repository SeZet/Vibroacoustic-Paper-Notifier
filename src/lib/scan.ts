import { ensureSchema, getVenues, sql, type Person } from "./db";
import { addAbstracts, fetchCandidates, type Paper } from "./sources";
import { rankPapers } from "./rank";

const DAY = 24 * 60 * 60 * 1000;
const MAX_LOOKBACK_DAYS = 62;

function periodStart(p: Person, now: Date): Date {
  const start = new Date(now);
  if (p.frequency === "monthly") start.setMonth(start.getMonth() - 1);
  else start.setTime(now.getTime() - 7 * DAY);
  return start;
}

/** Start of the window a scan for this person should cover. */
function windowStart(p: Person, now: Date): Date {
  const start = p.last_scan_at ? new Date(p.last_scan_at) : periodStart(p, now);
  const earliest = new Date(now.getTime() - MAX_LOOKBACK_DAYS * DAY);
  return start < earliest ? earliest : start;
}

/** True when the person's weekly or monthly scan is due. */
export function isDue(p: Person, now: Date): boolean {
  if (!p.interests.trim()) return false;
  if (!p.last_scan_at) return true;
  // A few hours of slack so a daily cron at a fixed time does not slip a day.
  return new Date(p.last_scan_at).getTime() <= periodStart(p, now).getTime() + 6 * 60 * 60 * 1000;
}

async function markScanning(personId: number): Promise<boolean> {
  // Skip if another scan for this person started in the last 10 minutes.
  const rows = await sql`
    UPDATE people SET scanning_since = now()
    WHERE id = ${personId} AND (scanning_since IS NULL OR scanning_since < now() - interval '10 minutes')
    RETURNING id`;
  return rows.length > 0;
}

async function finish(personId: number, status: string, scannedUntil: Date | null) {
  if (scannedUntil) {
    await sql`UPDATE people SET scanning_since = NULL, last_scan_status = ${status}, last_scan_at = ${scannedUntil.toISOString()} WHERE id = ${personId}`;
  } else {
    await sql`UPDATE people SET scanning_since = NULL, last_scan_status = ${status} WHERE id = ${personId}`;
  }
}

async function scanOne(person: Person, pool: Paper[], now: Date, sourceErrors: string[]): Promise<string> {
  const from = windowStart(person, now);
  // Crossref dates are by day, so compare on the date to avoid dropping same-day records.
  const fromDay = from.toISOString().slice(0, 10);
  const candidates = pool.filter((p) => p.created.slice(0, 10) >= fromDay);

  // Don't ask about papers this person has already seen (including removed ones).
  const seenRows = await sql`SELECT doi FROM recommendations WHERE person_id = ${person.id}`;
  const seen = new Set(seenRows.map((r) => String(r.doi)));
  const fresh = candidates.filter((p) => !seen.has(p.doi));

  const matches = await rankPapers(person.interests, fresh);
  for (const m of matches) {
    const p = m.paper;
    await sql`
      INSERT INTO recommendations (person_id, doi, title, venue, authors, published, abstract, url, score, reason)
      VALUES (${person.id}, ${p.doi}, ${p.title}, ${p.venue}, ${p.authors}, ${p.published}, ${p.abstract}, ${p.url}, ${m.score}, ${m.reason})
      ON CONFLICT (person_id, doi) DO NOTHING`;
  }
  const range = `${fromDay} to ${now.toISOString().slice(0, 10)}`;
  let status = `${matches.length} new recommendation${matches.length === 1 ? "" : "s"} from ${fresh.length} papers published ${range}.`;
  if (sourceErrors.length) status += ` Some venues could not be read: ${sourceErrors.join("; ")}`;
  return status;
}

/**
 * Scans for the given people. New papers are fetched once for everyone and
 * then judged against each person's interests.
 */
export async function runScans(people: Person[], opts: { timeBudgetMs?: number } = {}) {
  await ensureSchema();
  const started = Date.now();
  const budget = opts.timeBudgetMs ?? 200_000;
  const now = new Date();

  const ready: Person[] = [];
  for (const p of people) {
    if (!p.interests.trim()) {
      await finish(p.id, "Add your research interests first, then scan.", null);
      continue;
    }
    if (await markScanning(p.id)) ready.push(p);
  }
  if (ready.length === 0) return [];

  const results: { name: string; status: string }[] = [];
  try {
    const earliest = new Date(Math.min(...ready.map((p) => windowStart(p, now).getTime())));
    const venues = await getVenues();
    const { papers, errors } = await fetchCandidates(venues, earliest, now);
    if (papers.length === 0 && errors.length > 0) {
      throw new Error(`Could not reach Crossref: ${errors.join("; ")}`);
    }
    await addAbstracts(papers);

    // Two people at a time keeps the run inside Vercel's time limit.
    let next = 0;
    const worker = async () => {
      while (next < ready.length) {
        const person = ready[next++];
        if (Date.now() - started > budget) {
          await finish(person.id, "Postponed to the next run (time limit reached).", null);
          results.push({ name: person.name, status: "postponed" });
          continue;
        }
        try {
          const status = await scanOne(person, papers, now, errors);
          await finish(person.id, status, now);
          results.push({ name: person.name, status });
        } catch (err) {
          const msg = `Scan failed: ${err instanceof Error ? err.message : String(err)}`;
          await finish(person.id, msg, null);
          results.push({ name: person.name, status: msg });
        }
      }
    };
    await Promise.all([worker(), worker()]);
  } catch (err) {
    const msg = `Scan failed: ${err instanceof Error ? err.message : String(err)}`;
    for (const p of ready) {
      if (!results.some((r) => r.name === p.name)) {
        await finish(p.id, msg, null);
        results.push({ name: p.name, status: msg });
      }
    }
  }
  return results;
}

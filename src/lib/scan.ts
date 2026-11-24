import { createHash } from "node:crypto";
import { ensureSchema, getVenues, sql, type Person } from "./db";
import { addAbstracts, fetchCandidates, type Paper } from "./sources";
import { rankPapers, type Match } from "./rank";

/** Moves everything still on the Recommended list (not saved) to Deleted. */
export async function archiveUnsaved(personId: number) {
  await sql`UPDATE recommendations SET status = 'deleted', status_changed_at = now()
    WHERE person_id = ${personId} AND status = 'new'`;
}

export async function storeMatches(personId: number, matches: Match[]) {
  for (const m of matches) {
    const p = m.paper;
    await sql`
      INSERT INTO recommendations (person_id, doi, title, venue, authors, published, abstract, url, score, reason)
      VALUES (${personId}, ${p.doi}, ${p.title}, ${p.venue}, ${p.authors}, ${p.published}, ${p.abstract}, ${p.url}, ${m.score}, ${m.reason})
      ON CONFLICT (person_id, doi) DO NOTHING`;
  }
}

function interestsHash(interests: string): string {
  return createHash("sha1").update(interests.trim()).digest("hex").slice(0, 16);
}

/**
 * Leaves out papers already recommended to this person (in any list, so
 * deleted papers never come back) and papers Claude already judged against
 * the current wording of their interests.
 */
export async function unseenPapers(person: Person, papers: Paper[]): Promise<Paper[]> {
  const hash = interestsHash(person.interests);
  const rows = await sql`
    SELECT doi FROM recommendations WHERE person_id = ${person.id}
    UNION SELECT doi FROM checked WHERE person_id = ${person.id} AND interests_hash = ${hash}`;
  const seen = new Set(rows.map((r) => String(r.doi)));
  // The same paper can come back under another key (a feed link first, its DOI later),
  // so titles already recommended count as seen too.
  const titleRows = await sql`SELECT title FROM recommendations WHERE person_id = ${person.id}`;
  const seenTitles = new Set(titleRows.map((r) => titleKey(String(r.title))));
  return papers.filter((p) => !seen.has(p.doi) && !seenTitles.has(titleKey(p.title)));
}

function titleKey(t: string): string {
  return t.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();
}

export async function markChecked(person: Person, papers: Paper[]) {
  if (papers.length === 0) return;
  const hash = interestsHash(person.interests);
  const dois = papers.map((p) => p.doi);
  await sql`INSERT INTO checked (person_id, doi, interests_hash)
    SELECT ${person.id}, d, ${hash} FROM unnest(${dois}::text[]) AS d
    ON CONFLICT DO NOTHING`;
}

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

async function scanOne(
  person: Person,
  pool: Paper[],
  now: Date,
  sourceErrors: string[],
  sourceWarnings: string[],
  deadline: number,
): Promise<{ status: string; complete: boolean }> {
  const from = windowStart(person, now);
  // Crossref dates are by day, so compare on the date to avoid dropping same-day records.
  const fromDay = from.toISOString().slice(0, 10);
  const candidates = pool.filter((p) => p.created.slice(0, 10) >= fromDay);
  const fresh = await unseenPapers(person, candidates);

  const { matches, judged } = await rankPapers(person.interests, fresh, { deadline });
  const allJudged = judged.length === fresh.length;
  // When a venue could not be read, its papers from this window are still missing,
  // so the window stays open and the next run reads it again (already judged papers are skipped).
  const complete = allJudged && sourceErrors.length === 0;

  // A new scan replaces the Recommended list: anything not saved moves to Deleted.
  // A scan that continues an unfinished one keeps what that one already found.
  if (!person.scan_pending) await archiveUnsaved(person.id);
  await storeMatches(person.id, matches);
  await markChecked(person, judged);
  await sql`UPDATE people SET scan_pending = ${!complete} WHERE id = ${person.id}`;

  const range = `${fromDay} to ${now.toISOString().slice(0, 10)}`;
  let status = allJudged
    ? `${matches.length} new recommendation${matches.length === 1 ? "" : "s"} from ${fresh.length} new papers published ${range}.`
    : `Checked ${judged.length} of ${fresh.length} new papers published ${range} and found ${matches.length}. The rest are checked on the next run (or click Scan now again).`;
  if (sourceErrors.length) status += ` Some venues could not be read: ${sourceErrors.join("; ")}. They are read again on the next run.`;
  if (sourceWarnings.length) status += ` Some journal feeds could not be read (those journals were still checked through Crossref): ${sourceWarnings.join("; ")}.`;
  return { status, complete };
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
    const { papers, errors, warnings } = await fetchCandidates(venues, earliest, now);
    if (papers.length === 0 && errors.length > 0) {
      throw new Error(`Could not read any venue: ${errors.join("; ")}`);
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
          const { status, complete } = await scanOne(person, papers, now, errors, warnings, started + budget);
          // Only move the start of the next window forward once everything in this one was checked.
          await finish(person.id, status, complete ? now : null);
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

import { ensureSchema, getVenues, sql, type Person, type RangeJob } from "./db";
import { addAbstracts, countCandidates, fetchCandidates } from "./sources";
import { estimateCostUsd, rankPapers } from "./rank";
import { archiveUnsaved, markChecked, storeMatches, unseenPapers } from "./scan";

/** Longest time window one search may cover. */
export const MAX_RANGE_YEARS = 10;
/** Each step of a time-window search covers this many days (keeps each step well inside Vercel's time limit). */
const CHUNK_DAYS = 14;
const DAY = 24 * 60 * 60 * 1000;
const STEP_BUDGET_MS = 180_000;

export interface RangeEstimate {
  from: string;
  to: string;
  papers: number;
  costUsd: number;
  minutes: number;
  perVenue: { name: string; count: number }[];
  warnings: string[];
}

function parseDay(s: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function iso(d: Date) {
  return d.toISOString().slice(0, 10);
}

/** Checks the requested window and returns it as dates, or an error message. */
export function validateRange(fromStr: string, toStr: string): { from: Date; to: Date } | { error: string } {
  const from = parseDay(fromStr);
  let to = parseDay(toStr);
  if (!from || !to) return { error: "Please choose both a start and an end date." };
  const today = new Date(`${iso(new Date())}T00:00:00Z`);
  if (to > today) to = today;
  if (from > to) return { error: "The start date must be before the end date." };
  if (to.getTime() - from.getTime() > MAX_RANGE_YEARS * 366 * DAY) {
    return { error: `A search can cover at most ${MAX_RANGE_YEARS} years. Split it into several searches.` };
  }
  return { from, to };
}

export async function estimateRange(fromStr: string, toStr: string): Promise<RangeEstimate | { error: string }> {
  await ensureSchema();
  const range = validateRange(fromStr, toStr);
  if ("error" in range) return range;
  const venues = await getVenues();
  const { total, perVenue, errors } = await countCandidates(venues, range.from, range.to);
  if (total === 0 && errors.length > 0) {
    return { error: `Could not reach Crossref to count the papers. Please try again later. (${errors[0]})` };
  }
  const chunks = Math.ceil((range.to.getTime() - range.from.getTime() + DAY) / (CHUNK_DAYS * DAY));
  return {
    from: iso(range.from),
    to: iso(range.to),
    papers: total,
    costUsd: estimateCostUsd(total),
    // About 30 s per batch of 60 papers, three batches at a time, plus fetching.
    minutes: Math.max(1, Math.round((chunks * 10 + (total / 60) * 12) / 60)),
    perVenue,
    warnings: errors.length ? [`Could not count some venues: ${errors.join("; ")}`] : [],
  };
}

/** Starts a time-window search. Any earlier unfinished search for this person is cancelled. */
export async function startRangeJob(person: Person, fromStr: string, toStr: string): Promise<RangeJob | { error: string }> {
  await ensureSchema();
  if (!person.interests.trim()) return { error: "Add your research interests first." };
  const range = validateRange(fromStr, toStr);
  if ("error" in range) return range;
  await sql`UPDATE range_jobs SET status = 'cancelled' WHERE person_id = ${person.id} AND status IN ('running', 'paused')`;
  // A new search replaces the Recommended list, like a regular scan.
  await archiveUnsaved(person.id);
  const rows = await sql`
    INSERT INTO range_jobs (person_id, from_date, to_date, cursor_date)
    VALUES (${person.id}, ${iso(range.from)}, ${iso(range.to)}, ${iso(range.from)})
    RETURNING id, person_id, from_date::text AS from_date, to_date::text AS to_date, cursor_date::text AS cursor_date,
              status, checked, found, message`;
  return rows[0] as unknown as RangeJob;
}

async function getJob(jobId: number): Promise<RangeJob | null> {
  const rows = await sql`
    SELECT id, person_id, from_date::text AS from_date, to_date::text AS to_date, cursor_date::text AS cursor_date,
           status, checked, found, message
    FROM range_jobs WHERE id = ${jobId}`;
  return (rows[0] as unknown as RangeJob) ?? null;
}

/**
 * Runs the next step (two weeks of publications) of a time-window search and
 * returns the updated job. The browser calls this repeatedly while the page is open.
 */
export async function runRangeStep(jobId: number): Promise<RangeJob | null> {
  const started = Date.now();
  await ensureSchema();
  // Take a short lock so two open tabs don't process the same step.
  const locked = await sql`
    UPDATE range_jobs SET locked_until = now() + interval '5 minutes'
    WHERE id = ${jobId} AND status = 'running' AND (locked_until IS NULL OR locked_until < now())
    RETURNING id`;
  if (locked.length === 0) return getJob(jobId);

  const job = (await getJob(jobId))!;
  const personRows = await sql`SELECT * FROM people WHERE id = ${job.person_id}`;
  const person = personRows[0] as unknown as Person | undefined;
  if (!person) {
    await sql`UPDATE range_jobs SET status = 'cancelled', locked_until = NULL WHERE id = ${jobId}`;
    return getJob(jobId);
  }

  const from = new Date(`${job.cursor_date}T00:00:00Z`);
  const end = new Date(`${job.to_date}T00:00:00Z`);
  const stepEnd = new Date(Math.min(from.getTime() + (CHUNK_DAYS - 1) * DAY, end.getTime()));

  try {
    const venues = await getVenues();
    const { papers, errors } = await fetchCandidates(venues, from, stepEnd, "pub");
    if (papers.length === 0 && errors.length > 0) throw new Error(`Could not reach Crossref: ${errors.join("; ")}`);
    const fresh = await unseenPapers(person, papers);
    await addAbstracts(fresh);
    // Leave enough time to save the results before Vercel's 300 s limit.
    const { matches, judged } = await rankPapers(person.interests, fresh, { deadline: started + STEP_BUDGET_MS });
    await storeMatches(person.id, matches);
    await markChecked(person, judged);

    // If not everything in these two weeks was checked in time, the next step continues here.
    const stepDone = judged.length === fresh.length;
    const next = new Date(stepEnd.getTime() + DAY);
    const done = stepDone && next > end;
    const cursor = stepDone ? (done ? end : next) : from;
    const message = errors.length ? `Some venues could not be read for ${iso(from)} to ${iso(stepEnd)}: ${errors.join("; ")}` : null;
    await sql`
      UPDATE range_jobs SET
        cursor_date = ${iso(cursor)},
        checked = checked + ${judged.length},
        found = found + ${matches.length},
        status = ${done ? "done" : "running"},
        message = COALESCE(${message}, message),
        locked_until = NULL
      WHERE id = ${jobId}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await sql`UPDATE range_jobs SET status = 'paused', message = ${msg}, locked_until = NULL WHERE id = ${jobId}`;
  }
  return getJob(jobId);
}

export async function resumeRangeJob(jobId: number) {
  await sql`UPDATE range_jobs SET status = 'running', message = NULL WHERE id = ${jobId} AND status = 'paused'`;
  return getJob(jobId);
}

export async function cancelRangeJob(jobId: number) {
  await sql`UPDATE range_jobs SET status = 'cancelled', locked_until = NULL WHERE id = ${jobId} AND status IN ('running', 'paused')`;
  return getJob(jobId);
}

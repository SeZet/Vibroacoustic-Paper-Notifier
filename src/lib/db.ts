import { neon } from "@neondatabase/serverless";
import { arxivStarterVenue, DEFAULT_PEOPLE, DEFAULT_VENUES, type VenueKind } from "./defaults";

export type Frequency = "weekly" | "monthly";

export interface Person {
  id: number;
  name: string;
  slug: string;
  interests: string;
  frequency: Frequency;
  last_scan_at: string | null;
  last_scan_status: string | null;
  scanning_since: string | null;
  scan_pending: boolean;
}

export interface Venue {
  id: number;
  name: string;
  issns: string;
  match_text: string;
  enabled: boolean;
  kind: VenueKind;
  feed_url: string;
}

export type RecStatus = "new" | "saved" | "deleted";

export interface Recommendation {
  id: number;
  person_id: number;
  doi: string;
  title: string;
  venue: string;
  authors: string;
  published: string | null;
  abstract: string | null;
  url: string;
  score: number;
  reason: string;
  status: RecStatus;
  created_at: string;
}

type Sql = ReturnType<typeof neon>;
let client: Sql | null = null;

/** Tagged-template SQL client. Rows come back as plain objects. */
export function sql(strings: TemplateStringsArray, ...values: unknown[]) {
  if (!client) {
    const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!url) {
      throw new Error(
        "No database configured. Connect a Neon Postgres database in Vercel (Storage tab) so DATABASE_URL is set.",
      );
    }
    client = neon(url);
  }
  return client(strings, ...values) as Promise<Record<string, unknown>[]>;
}

let schemaReady: Promise<void> | null = null;

/** Creates tables and seeds the group members and starter venues on first use. */
export function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = createSchema().catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

async function createSchema() {
  await sql`CREATE TABLE IF NOT EXISTS people (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    slug TEXT NOT NULL UNIQUE,
    interests TEXT NOT NULL DEFAULT '',
    frequency TEXT NOT NULL DEFAULT 'weekly' CHECK (frequency IN ('weekly', 'monthly')),
    last_scan_at TIMESTAMPTZ,
    last_scan_status TEXT,
    scanning_since TIMESTAMPTZ
  )`;
  await sql`CREATE TABLE IF NOT EXISTS venues (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    issns TEXT NOT NULL DEFAULT '',
    match_text TEXT NOT NULL DEFAULT '',
    enabled BOOLEAN NOT NULL DEFAULT TRUE
  )`;
  await sql`CREATE TABLE IF NOT EXISTS recommendations (
    id SERIAL PRIMARY KEY,
    person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    doi TEXT NOT NULL,
    title TEXT NOT NULL,
    venue TEXT NOT NULL DEFAULT '',
    authors TEXT NOT NULL DEFAULT '',
    published DATE,
    abstract TEXT,
    url TEXT NOT NULL,
    score INTEGER NOT NULL DEFAULT 0,
    reason TEXT NOT NULL DEFAULT '',
    dismissed BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (person_id, doi)
  )`;
  // v2: Recommended / Saved / Deleted lists replace the old "dismissed" flag.
  await sql`ALTER TABLE recommendations ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'new'`;
  await sql`ALTER TABLE recommendations ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ NOT NULL DEFAULT now()`;
  await sql`UPDATE recommendations SET status = 'deleted', dismissed = FALSE WHERE dismissed`;
  await sql`CREATE INDEX IF NOT EXISTS recommendations_person_status ON recommendations (person_id, status)`;
  // Every paper Claude has judged for a person, per version of their interests,
  // so interrupted scans can continue and nothing is paid for twice.
  await sql`CREATE TABLE IF NOT EXISTS checked (
    person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    doi TEXT NOT NULL,
    interests_hash TEXT NOT NULL,
    PRIMARY KEY (person_id, interests_hash, doi)
  )`;
  await sql`ALTER TABLE people ADD COLUMN IF NOT EXISTS scan_pending BOOLEAN NOT NULL DEFAULT FALSE`;
  await sql`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;
  // Tokens and cost of every Claude API call, for the API cost page.
  await sql`CREATE TABLE IF NOT EXISTS api_usage (
    id SERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0
  )`;

  // v3: journal RSS feeds and arXiv as extra sources.
  await sql`ALTER TABLE venues ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'journal'`;
  await sql`ALTER TABLE venues ADD COLUMN IF NOT EXISTS feed_url TEXT NOT NULL DEFAULT ''`;

  for (const name of DEFAULT_PEOPLE) {
    await sql`INSERT INTO people (name, slug) VALUES (${name}, ${slugify(name)})
      ON CONFLICT (name) DO NOTHING`;
  }

  // Seed venues only once, so venues someone deletes do not come back.
  const seeded = await sql`SELECT value FROM meta WHERE key = 'venues_seeded'`;
  if (seeded.length === 0) {
    for (const v of DEFAULT_VENUES) {
      await sql`INSERT INTO venues (name, kind, issns, match_text, feed_url)
        VALUES (${v.name}, ${v.kind ?? "journal"}, ${v.issns}, ${v.match_text}, ${v.feed_url ?? ""})`;
    }
    await sql`INSERT INTO meta (key, value) VALUES ('venues_seeded', 'yes') ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO meta (key, value) VALUES ('sources_v3_seeded', 'yes') ON CONFLICT DO NOTHING`;
  }

  // Sites set up before feeds and arXiv existed: add the starter feeds to the
  // matching journals (found by ISSN) and the arXiv venue, once.
  const v3 = await sql`SELECT value FROM meta WHERE key = 'sources_v3_seeded'`;
  if (v3.length === 0) {
    for (const v of DEFAULT_VENUES) {
      const issn = v.issns.split(",")[0]?.trim();
      if (!v.feed_url || !issn) continue;
      await sql`UPDATE venues SET feed_url = ${v.feed_url}
        WHERE feed_url = '' AND kind = 'journal' AND issns LIKE ${"%" + issn + "%"}`;
    }
    const a = arxivStarterVenue();
    await sql`INSERT INTO venues (name, kind, issns, match_text) VALUES (${a.name}, 'arxiv', '', ${a.match_text})`;
    await sql`INSERT INTO meta (key, value) VALUES ('sources_v3_seeded', 'yes') ON CONFLICT DO NOTHING`;
  }
}

export function slugify(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export async function getPeople(): Promise<(Person & { open_count: number })[]> {
  await ensureSchema();
  const rows = await sql`
    SELECT p.*, (SELECT count(*)::int FROM recommendations r WHERE r.person_id = p.id AND r.status = 'new') AS open_count
    FROM people p ORDER BY p.name`;
  return rows as unknown as (Person & { open_count: number })[];
}

export async function getPersonBySlug(slug: string): Promise<Person | null> {
  await ensureSchema();
  const rows = await sql`SELECT * FROM people WHERE slug = ${slug}`;
  return (rows[0] as unknown as Person) ?? null;
}

const LIST_LIMIT = 300;

export async function getRecommendations(personId: number, status: RecStatus): Promise<Recommendation[]> {
  const rows =
    status === "new"
      ? await sql`
        SELECT id, person_id, doi, title, venue, authors, published::text AS published, abstract, url, score, reason, status, created_at
        FROM recommendations WHERE person_id = ${personId} AND status = 'new'
        ORDER BY score DESC, published DESC NULLS LAST LIMIT ${LIST_LIMIT}`
      : await sql`
        SELECT id, person_id, doi, title, venue, authors, published::text AS published, abstract, url, score, reason, status, created_at
        FROM recommendations WHERE person_id = ${personId} AND status = ${status}
        ORDER BY status_changed_at DESC, id DESC LIMIT ${LIST_LIMIT}`;
  return rows as unknown as Recommendation[];
}

export async function getStatusCounts(personId: number): Promise<Record<RecStatus, number>> {
  const rows = await sql`
    SELECT status, count(*)::int AS n FROM recommendations WHERE person_id = ${personId} GROUP BY status`;
  const counts: Record<RecStatus, number> = { new: 0, saved: 0, deleted: 0 };
  for (const r of rows) counts[r.status as RecStatus] = Number(r.n);
  return counts;
}

export async function getVenues(): Promise<Venue[]> {
  await ensureSchema();
  const rows = await sql`SELECT * FROM venues ORDER BY name`;
  return rows as unknown as Venue[];
}

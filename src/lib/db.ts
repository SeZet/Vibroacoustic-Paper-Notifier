import { neon } from "@neondatabase/serverless";
import { DEFAULT_PEOPLE, DEFAULT_VENUES } from "./defaults";

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
}

export interface Venue {
  id: number;
  name: string;
  issns: string;
  match_text: string;
  enabled: boolean;
}

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
  await sql`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;

  for (const name of DEFAULT_PEOPLE) {
    await sql`INSERT INTO people (name, slug) VALUES (${name}, ${slugify(name)})
      ON CONFLICT (name) DO NOTHING`;
  }

  // Seed venues only once, so venues someone deletes do not come back.
  const seeded = await sql`SELECT value FROM meta WHERE key = 'venues_seeded'`;
  if (seeded.length === 0) {
    for (const v of DEFAULT_VENUES) {
      await sql`INSERT INTO venues (name, issns, match_text) VALUES (${v.name}, ${v.issns}, ${v.match_text})`;
    }
    await sql`INSERT INTO meta (key, value) VALUES ('venues_seeded', 'yes') ON CONFLICT DO NOTHING`;
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
    SELECT p.*, (SELECT count(*)::int FROM recommendations r WHERE r.person_id = p.id AND NOT r.dismissed) AS open_count
    FROM people p ORDER BY p.name`;
  return rows as unknown as (Person & { open_count: number })[];
}

export async function getPersonBySlug(slug: string): Promise<Person | null> {
  await ensureSchema();
  const rows = await sql`SELECT * FROM people WHERE slug = ${slug}`;
  return (rows[0] as unknown as Person) ?? null;
}

export async function getRecommendations(personId: number): Promise<Recommendation[]> {
  const rows = await sql`
    SELECT id, person_id, doi, title, venue, authors, published::text AS published, abstract, url, score, reason, created_at
    FROM recommendations
    WHERE person_id = ${personId} AND NOT dismissed
    ORDER BY created_at::date DESC, score DESC, published DESC NULLS LAST`;
  return rows as unknown as Recommendation[];
}

export async function getVenues(): Promise<Venue[]> {
  await ensureSchema();
  const rows = await sql`SELECT * FROM venues ORDER BY name`;
  return rows as unknown as Venue[];
}

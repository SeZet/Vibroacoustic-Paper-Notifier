import type { Venue } from "./db";

/** A candidate publication gathered from the bibliographic databases. */
export interface Paper {
  doi: string;
  title: string;
  venue: string;
  authors: string;
  published: string | null; // YYYY-MM-DD
  created: string; // ISO timestamp the DOI record was first registered
  abstract: string | null;
  url: string;
}

const MAX_PER_VENUE = 3000;

function politeParams(): string {
  const email = process.env.CONTACT_EMAIL;
  return email ? `&mailto=${encodeURIComponent(email)}` : "";
}

function userAgent(): string {
  const email = process.env.CONTACT_EMAIL;
  return `VibroacousticPaperNotifier/1.0${email ? ` (mailto:${email})` : ""}`;
}

async function fetchJson(url: string, init: RequestInit = {}, attempts = 3): Promise<unknown> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        ...init,
        headers: { "User-Agent": userAgent(), Accept: "application/json", ...(init.headers ?? {}) },
        cache: "no-store",
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`${res.status} from ${new URL(url).host}`);
        await sleep(1500 * (i + 1));
        continue;
      }
      if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
      return await res.json();
    } catch (err) {
      lastError = err;
      await sleep(1000 * (i + 1));
    }
  }
  throw lastError;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function day(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ */
/* Crossref: the list of new publications per venue                    */
/* ------------------------------------------------------------------ */

interface CrossrefItem {
  DOI: string;
  title?: string[];
  "container-title"?: string[];
  author?: { given?: string; family?: string; name?: string }[];
  created?: { "date-time"?: string };
  published?: { "date-parts"?: number[][] };
  "published-online"?: { "date-parts"?: number[][] };
  "published-print"?: { "date-parts"?: number[][] };
  abstract?: string;
  type?: string;
  event?: { name?: string };
}

const SKIP_TITLES =
  /^(editorial board|erratum|corrigendum|correction|retraction|table of contents|contents|front matter|back matter|cover|index|masthead|issue information|reviewers|acknowledg)/i;

function dateFromParts(parts?: number[][]): string | null {
  const p = parts?.[0];
  if (!p || !p[0]) return null;
  const [y, m = 1, d = 1] = p;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function cleanAbstract(raw: string): string {
  return raw
    .replace(/<jats:title>.*?<\/jats:title>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .replace(/^(abstract|summary)[:.\s]+/i, "")
    .trim();
}

function toPaper(item: CrossrefItem, fallbackVenue: string): Paper | null {
  const title = item.title?.[0]?.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  if (!title || SKIP_TITLES.test(title)) return null;
  if (item.type && !["journal-article", "proceedings-article", "posted-content", "book-chapter"].includes(item.type)) {
    return null;
  }
  const authors = (item.author ?? [])
    .map((a) => a.name ?? [a.given, a.family].filter(Boolean).join(" "))
    .filter(Boolean);
  const doi = item.DOI.toLowerCase();
  return {
    doi,
    title,
    venue: item["container-title"]?.[0] || item.event?.name || fallbackVenue,
    authors: authors.length > 6 ? `${authors.slice(0, 6).join(", ")} et al.` : authors.join(", "),
    published:
      dateFromParts(item["published-online"]?.["date-parts"]) ??
      dateFromParts(item.published?.["date-parts"]) ??
      dateFromParts(item["published-print"]?.["date-parts"]),
    created: item.created?.["date-time"] ?? new Date().toISOString(),
    abstract: item.abstract ? cleanAbstract(item.abstract) || null : null,
    url: `https://doi.org/${doi}`,
  };
}

const SELECT = "DOI,title,container-title,author,created,published,published-online,published-print,abstract,type,event";

/** Crossref query for records of this venue whose DOI was registered between `from` and `until`. */
function venueQuery(venue: Venue, from: Date, until: Date): string | null {
  const issns = venue.issns
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const dateFilter = `from-created-date:${day(from)},until-created-date:${day(until)}`;
  const match = venue.match_text.trim();
  if (issns.length > 0) {
    const issnFilter = issns.map((i) => `issn:${i}`).join(",");
    return `https://api.crossref.org/works?filter=${issnFilter},${dateFilter}`;
  }
  if (match) {
    return `https://api.crossref.org/works?query.container-title=${encodeURIComponent(match)}&filter=${dateFilter}`;
  }
  return null;
}

function matchesVenue(item: CrossrefItem, match: string): boolean {
  const container = `${item["container-title"]?.join(" ") ?? ""} ${item.event?.name ?? ""}`.toLowerCase();
  return container.includes(match);
}

async function crossrefVenue(venue: Venue, from: Date, until: Date): Promise<Paper[]> {
  const base = venueQuery(venue, from, until);
  if (!base) return [];
  const issns = venue.issns.trim();
  const match = venue.match_text.trim().toLowerCase();

  const papers: Paper[] = [];
  let cursor = "*";
  while (papers.length < MAX_PER_VENUE) {
    const url = `${base}&rows=500&select=${SELECT}&cursor=${encodeURIComponent(cursor)}${politeParams()}`;
    const data = (await fetchJson(url)) as { message: { items: CrossrefItem[]; "next-cursor"?: string } };
    const items = data.message.items ?? [];
    for (const item of items) {
      if (match && !issns && !matchesVenue(item, match)) continue;
      const p = toPaper(item, venue.name);
      if (p) papers.push(p);
    }
    if (items.length < 500 || !data.message["next-cursor"]) break;
    cursor = data.message["next-cursor"];
  }
  return papers;
}

/** Collects new publications from all enabled venues registered between `from` and `until`. */
export async function fetchCandidates(
  venues: Venue[],
  from: Date,
  until: Date,
): Promise<{ papers: Paper[]; errors: string[] }> {
  const errors: string[] = [];
  const results = await Promise.all(
    venues
      .filter((v) => v.enabled)
      .map((v) =>
        crossrefVenue(v, from, until).catch((err) => {
          errors.push(`${v.name}: ${err instanceof Error ? err.message : String(err)}`);
          return [] as Paper[];
        }),
      ),
  );
  const byDoi = new Map<string, Paper>();
  for (const p of results.flat()) if (!byDoi.has(p.doi)) byDoi.set(p.doi, p);
  return { papers: [...byDoi.values()], errors };
}

/* ------------------------------------------------------------------ */
/* Abstracts: OpenAlex first, then Semantic Scholar                    */
/* ------------------------------------------------------------------ */

function fromInvertedIndex(index: Record<string, number[]> | null | undefined): string | null {
  if (!index) return null;
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const pos of positions) words[pos] = word;
  }
  const text = words.filter(Boolean).join(" ").trim();
  return text || null;
}

async function openAlexAbstracts(dois: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const key = process.env.OPENALEX_API_KEY ? `&api_key=${encodeURIComponent(process.env.OPENALEX_API_KEY)}` : "";
  for (let i = 0; i < dois.length; i += 50) {
    const chunk = dois.slice(i, i + 50);
    const filter = chunk.map((d) => `https://doi.org/${d}`).join("|");
    const url = `https://api.openalex.org/works?filter=doi:${encodeURIComponent(filter)}&per-page=50&select=doi,abstract_inverted_index${politeParams()}${key}`;
    try {
      const data = (await fetchJson(url)) as {
        results: { doi?: string; abstract_inverted_index?: Record<string, number[]> }[];
      };
      for (const w of data.results ?? []) {
        const text = fromInvertedIndex(w.abstract_inverted_index);
        if (w.doi && text) found.set(w.doi.replace(/^https?:\/\/doi\.org\//i, "").toLowerCase(), text);
      }
    } catch {
      // Best effort: a failed lookup only means fewer abstracts.
    }
  }
  return found;
}

async function semanticScholarAbstracts(dois: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (process.env.SEMANTIC_SCHOLAR_API_KEY) headers["x-api-key"] = process.env.SEMANTIC_SCHOLAR_API_KEY;
  for (let i = 0; i < dois.length; i += 400) {
    const chunk = dois.slice(i, i + 400);
    try {
      const data = (await fetchJson(
        "https://api.semanticscholar.org/graph/v1/paper/batch?fields=abstract,externalIds",
        { method: "POST", headers, body: JSON.stringify({ ids: chunk.map((d) => `DOI:${d}`) }) },
        2,
      )) as ({ abstract?: string | null; externalIds?: { DOI?: string } } | null)[];
      data.forEach((paper, idx) => {
        if (paper?.abstract) found.set(chunk[idx], paper.abstract.trim());
      });
    } catch {
      // The public endpoint is rate limited; skip silently.
    }
  }
  return found;
}

/** Fills in missing abstracts in place. */
export async function addAbstracts(papers: Paper[]): Promise<void> {
  let missing = papers.filter((p) => !p.abstract);
  if (missing.length === 0) return;
  const oa = await openAlexAbstracts(missing.map((p) => p.doi));
  for (const p of missing) p.abstract = oa.get(p.doi) ?? null;

  missing = papers.filter((p) => !p.abstract);
  if (missing.length === 0) return;
  const s2 = await semanticScholarAbstracts(missing.map((p) => p.doi));
  for (const p of missing) p.abstract = s2.get(p.doi) ?? null;
}

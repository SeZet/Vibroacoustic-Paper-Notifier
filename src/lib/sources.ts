import type { Venue } from "./db";
import { arxivVenue, feedVenue } from "./feeds";

/**
 * A candidate publication gathered from the bibliographic databases.
 * `doi` is the paper's key: a lowercase DOI when known, otherwise
 * `arxiv:<id>` for preprints or `url:<link>` for feed items without a DOI.
 */
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
/**
 * Title searches (venues without an ISSN) match loosely: "Aeroacoustics
 * Conference" hits tens of thousands of unrelated conference records a month.
 * Results come sorted by relevance, so the real matches are on the first pages.
 */
const MAX_TITLE_SEARCH_PAGES = 2;
/** Crossref limits how many requests may run at once, so venues are read a few at a time. */
const VENUE_CONCURRENCY = 2;

function politeParams(): string {
  const email = process.env.CONTACT_EMAIL;
  return email ? `&mailto=${encodeURIComponent(email)}` : "";
}

function userAgent(): string {
  const email = process.env.CONTACT_EMAIL;
  return `VibroacousticPaperNotifier/1.0${email ? ` (mailto:${email})` : ""}`;
}

async function fetchJson(url: string, init: RequestInit = {}, attempts = 4): Promise<unknown> {
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
        lastError = new Error(
          res.status === 429
            ? `rate limited by ${new URL(url).host}`
            : `${res.status} from ${new URL(url).host}`,
        );
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : 2000 * 2 ** i);
        continue;
      }
      if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
      return await res.json();
    } catch (err) {
      lastError =
        err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")
          ? new Error(`no answer from ${new URL(url).host} within 30 s`)
          : err;
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
  let pages = 0;
  while (papers.length < MAX_PER_VENUE) {
    if (!issns && pages++ >= MAX_TITLE_SEARCH_PAGES) break;
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

function normTitle(t: string): string {
  return t.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Merges papers found by several sources. Records with the same DOI, or the
 * same title, count as one paper. The first one wins (Crossref is listed
 * first), and a missing abstract or author list is filled from the others.
 */
export function dedupe(papers: Paper[]): Paper[] {
  const byKey = new Map<string, Paper>();
  const out: Paper[] = [];
  for (const p of papers) {
    const titleKey = `t:${normTitle(p.title)}`;
    const existing = byKey.get(p.doi) ?? (titleKey.length > 12 ? byKey.get(titleKey) : undefined);
    if (existing) {
      if (!existing.abstract && p.abstract) existing.abstract = p.abstract;
      if (!existing.authors && p.authors) existing.authors = p.authors;
      if (!existing.published && p.published) existing.published = p.published;
      // Keep a real DOI (and its link) over a feed or arXiv identifier.
      if (!existing.doi.startsWith("10.") && p.doi.startsWith("10.")) {
        existing.doi = p.doi;
        existing.url = p.url;
        byKey.set(p.doi, existing);
      }
      continue;
    }
    byKey.set(p.doi, p);
    byKey.set(titleKey, p);
    out.push(p);
  }
  return out;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Collects new publications from all enabled venues registered between `from` and `until`:
 * Crossref for journals and conferences, plus each venue's RSS feed if it has one,
 * plus arXiv for arXiv venues.
 *
 * `errors` are sources whose papers are missing (the scan window stays open).
 * `warnings` are feeds that could not be read; their journals are still covered by Crossref.
 */
export async function fetchCandidates(
  venues: Venue[],
  from: Date,
  until: Date,
): Promise<{ papers: Paper[]; errors: string[]; warnings: string[] }> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const enabled = venues.filter((v) => v.enabled);
  const journals = enabled.filter((v) => v.kind !== "arxiv");
  const arxiv = enabled.filter((v) => v.kind === "arxiv");

  const crossrefResults: Paper[][] = [];
  let next = 0;
  const worker = async () => {
    while (next < journals.length) {
      const v = journals[next++];
      try {
        crossrefResults.push(await crossrefVenue(v, from, until));
      } catch (err) {
        errors.push(`${v.name}: ${message(err)}`);
      }
    }
  };

  // Feeds and arXiv are other hosts, so they run alongside the Crossref reads.
  const feedsDone = Promise.all(
    journals
      .filter((v) => v.feed_url.trim())
      .map((v) =>
        feedVenue(v, from).catch((err) => {
          warnings.push(`${v.name} feed: ${message(err)}`);
          return [] as Paper[];
        }),
      ),
  );
  // arXiv asks for one request at a time, so its venues are read one after another.
  const arxivDone = (async () => {
    const all: Paper[] = [];
    for (const v of arxiv) {
      try {
        all.push(...(await arxivVenue(v, from, until)));
      } catch (err) {
        errors.push(`${v.name}: ${message(err)}`);
      }
    }
    return all;
  })();

  await Promise.all(Array.from({ length: VENUE_CONCURRENCY }, worker));
  const feedResults = await feedsDone;
  const arxivResults = await arxivDone;

  const papers = dedupe([...crossrefResults.flat(), ...feedResults.flat(), ...arxivResults]);
  return { papers, errors, warnings };
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
  // Only real DOIs can be looked up; arXiv and feed items bring their own abstract if any.
  let missing = papers.filter((p) => !p.abstract && p.doi.startsWith("10."));
  if (missing.length === 0) return;
  const oa = await openAlexAbstracts(missing.map((p) => p.doi));
  for (const p of missing) p.abstract = oa.get(p.doi) ?? null;

  missing = missing.filter((p) => !p.abstract);
  if (missing.length === 0) return;
  const s2 = await semanticScholarAbstracts(missing.map((p) => p.doi));
  for (const p of missing) p.abstract = s2.get(p.doi) ?? null;
}

import type { Venue } from "./db";
import { cleanAbstract, type Paper } from "./sources";

/*
 * Extra sources next to Crossref:
 *  - journal RSS / Atom table-of-contents feeds (set per venue on the Venues page)
 *  - arXiv preprints (venues of kind "arxiv"; the venue's search text is an arXiv query)
 *
 * Neither needs a library: both formats are simple enough to read with a few
 * regular expressions, and a broken item is just skipped.
 */

const FEED_TIMEOUT_MS = 30_000;

function userAgent(): string {
  const email = process.env.CONTACT_EMAIL;
  return `VibroacousticPaperNotifier/1.0${email ? ` (mailto:${email})` : ""}`;
}

async function fetchText(url: string, accept: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": userAgent(), Accept: accept },
    cache: "no-store",
    signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
  }).catch((err: unknown) => {
    const host = new URL(url).host;
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new Error(`no answer from ${host} within ${FEED_TIMEOUT_MS / 1000} s`);
    }
    throw err;
  });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
  return res.text();
}

/* ------------------------------------------------------------------ */
/* Minimal XML helpers                                                 */
/* ------------------------------------------------------------------ */

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/** Text content of a tag: CDATA unwrapped and entities decoded (still may contain HTML). */
function unwrap(raw: string): string {
  const cdata = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  // Entities are decoded only outside CDATA in proper XML, but feeds mix both; decoding twice is harmless here.
  return decodeEntities(cdata).trim();
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** All values of a tag (namespace prefix included in `name`, e.g. "dc:creator"). */
function tags(block: string, name: string): string[] {
  const re = new RegExp(`<${escapeRe(name)}(?:\\s[^>]*)?>([\\s\\S]*?)</${escapeRe(name)}>`, "gi");
  return [...block.matchAll(re)].map((m) => unwrap(m[1]));
}

function tag(block: string, ...names: string[]): string | null {
  for (const n of names) {
    const v = tags(block, n).find((x) => x);
    if (v) return v;
  }
  return null;
}

function stripHtml(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

const DOI_RE = /\b(10\.\d{4,9}\/[^\s"'<>&]+)/i;

function findDoi(...texts: (string | null)[]): string | null {
  for (const t of texts) {
    if (!t) continue;
    const m = t.match(DOI_RE);
    if (m) return m[1].replace(/[.,;)\]]+$/, "").toLowerCase();
  }
  return null;
}

function isoDate(raw: string | null): string | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

const SKIP_TITLES =
  /^(editorial board|erratum|corrigendum|correction|retraction|table of contents|contents|front matter|back matter|cover|index|masthead|issue information|reviewers|acknowledg)/i;

/* ------------------------------------------------------------------ */
/* Journal RSS / Atom feeds                                            */
/* ------------------------------------------------------------------ */

/**
 * ScienceDirect puts "Publication date / Source / Author(s)" lines into the
 * description and sometimes the abstract after them. Pulls the authors out
 * and keeps only real abstract text.
 */
function splitDescription(html: string): { authors: string | null; abstract: string | null } {
  const authorMatch = html.match(/Author\(s\):\s*([\s\S]*?)(?:<\/p>|<br|$)/i);
  const authors = authorMatch ? stripHtml(authorMatch[1]) || null : null;
  const text = html
    .replace(/<p>\s*(Publication date|Source|Author\(s\)|Volume|Issue):[\s\S]*?<\/p>/gi, " ")
    .replace(/(Publication date|Source|Author\(s\)):[^<]*(<br\s*\/?>)?/gi, " ");
  const abstract = cleanAbstract(text);
  // Very short leftovers are teasers or metadata, not abstracts.
  return { authors, abstract: abstract.length >= 120 ? abstract : null };
}

function feedItemToPaper(block: string, venue: Venue): Paper | null {
  const title = tag(block, "title");
  const cleanTitle = title ? stripHtml(title) : "";
  if (!cleanTitle || SKIP_TITLES.test(cleanTitle)) return null;

  // RSS: <link>url</link>; Atom: <link href="url" rel="alternate"/>
  const atomLink =
    block.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i)?.[1] ??
    block.match(/<link[^>]*href=["']([^"']+)["']/i)?.[1] ??
    null;
  const link = tag(block, "link") || (atomLink ? decodeEntities(atomLink) : null);
  const guid = tag(block, "guid", "id");

  const doi = findDoi(
    tag(block, "prism:doi"),
    tag(block, "dc:identifier"),
    tag(block, "prism:url"),
    link,
    guid,
  );
  const url = doi ? `https://doi.org/${doi}` : link || guid;
  if (!url) return null;

  const description = tag(block, "content:encoded", "description", "summary", "content") ?? "";
  const { authors: descAuthors, abstract } = splitDescription(description);
  const creators = [...tags(block, "dc:creator"), ...tags(block, "name")].map(stripHtml).filter(Boolean);
  const authorList = creators.length ? creators.join(", ") : (descAuthors ?? "");

  const dated = isoDate(
    tag(block, "prism:coverDate", "dc:date", "pubDate", "published", "updated", "prism:publicationDate"),
  );

  return {
    doi: doi ?? `url:${url}`,
    title: cleanTitle,
    venue: venue.name,
    authors: authorList,
    published: dated ? dated.slice(0, 10) : null,
    // Feeds list only recent papers. Without a date, treat the item as new now;
    // papers already judged are skipped anyway.
    created: dated ?? new Date().toISOString(),
    abstract,
    url,
  };
}

export function parseFeed(xml: string, venue: Venue): Paper[] {
  const blocks = [
    ...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi),
    ...xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi),
  ].map((m) => m[1]);
  return blocks.map((b) => feedItemToPaper(b, venue)).filter((p): p is Paper => p !== null);
}

/** Papers from a venue's RSS / Atom feed published (or first seen) since `from`. */
export async function feedVenue(venue: Venue, from: Date): Promise<Paper[]> {
  const url = venue.feed_url.trim();
  if (!url) return [];
  const xml = await fetchText(url, "application/rss+xml, application/atom+xml, application/xml, text/xml");
  const fromDay = from.toISOString().slice(0, 10);
  return parseFeed(xml, venue).filter((p) => p.created.slice(0, 10) >= fromDay);
}

/* ------------------------------------------------------------------ */
/* arXiv                                                               */
/* ------------------------------------------------------------------ */

const ARXIV_PAGE = 200;
const ARXIV_MAX = 1000;
/** arXiv asks API users to wait about three seconds between requests. */
const ARXIV_DELAY_MS = 3100;

function arxivStamp(d: Date): string {
  const iso = d.toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}`;
}

function arxivEntryToPaper(block: string): Paper | null {
  const absUrl = tag(block, "id");
  const id = absUrl?.match(/arxiv\.org\/abs\/([^\s<]+?)(v\d+)?$/i)?.[1];
  const title = tag(block, "title");
  if (!id || !title) return null;
  const doi = tag(block, "arxiv:doi")?.toLowerCase() ?? null;
  const authors = tags(block, "name").map(stripHtml).filter(Boolean);
  const category = block.match(/<arxiv:primary_category[^>]*term=["']([^"']+)["']/i)?.[1];
  const journalRef = tag(block, "arxiv:journal_ref");
  const published = isoDate(tag(block, "published")) ?? new Date().toISOString();
  const summary = tag(block, "summary");
  return {
    // A preprint that already has a journal DOI is keyed by it, so it merges with the Crossref record.
    doi: doi ?? `arxiv:${id}`,
    title: stripHtml(title),
    venue: journalRef ? `arXiv (${journalRef})` : `arXiv${category ? ` (${category})` : ""}`,
    authors: authors.length > 6 ? `${authors.slice(0, 6).join(", ")} et al.` : authors.join(", "),
    published: published.slice(0, 10),
    created: published,
    abstract: summary ? stripHtml(summary) || null : null,
    url: `https://arxiv.org/abs/${id}`,
  };
}

/** New arXiv preprints matching the venue's search query, submitted between `from` and `until`. */
export async function arxivVenue(venue: Venue, from: Date, until: Date): Promise<Paper[]> {
  const query = venue.match_text.trim();
  if (!query) return [];
  const search = `(${query}) AND submittedDate:[${arxivStamp(from)} TO ${arxivStamp(until)}]`;
  const papers: Paper[] = [];
  for (let start = 0; start < ARXIV_MAX; start += ARXIV_PAGE) {
    if (start > 0) await new Promise((r) => setTimeout(r, ARXIV_DELAY_MS));
    const url =
      `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(search)}` +
      `&start=${start}&max_results=${ARXIV_PAGE}&sortBy=submittedDate&sortOrder=descending`;
    const xml = await fetchText(url, "application/atom+xml");
    const entries = [...xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi)].map((m) => m[1]);
    for (const e of entries) {
      const p = arxivEntryToPaper(e);
      if (p) papers.push(p);
    }
    if (entries.length < ARXIV_PAGE) break;
  }
  return papers;
}

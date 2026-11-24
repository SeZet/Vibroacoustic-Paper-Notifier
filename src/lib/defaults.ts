/** Group members. A section is created for each name on first start. */
export const DEFAULT_PEOPLE = ["René", "Marco", "Martin", "Ray", "Sebastian"];

export type VenueKind = "journal" | "arxiv";

export interface DefaultVenue {
  name: string;
  kind?: VenueKind;
  issns: string;
  match_text: string;
  feed_url?: string;
}

/** arXiv preprints on vibroacoustic topics. The query uses arXiv's search syntax and can be edited on the Venues page. */
export function arxivStarterVenue(): DefaultVenue {
  return {
    name: "arXiv preprints",
    kind: "arxiv",
    issns: "",
    match_text: DEFAULT_ARXIV_QUERY,
  };
}

export const DEFAULT_ARXIV_QUERY = [
  "abs:vibroacoustic",
  'abs:"vibro-acoustic"',
  "abs:aeroacoustic",
  "abs:aeroacoustics",
  'abs:"structural acoustics"',
  'abs:"structure-borne"',
  'abs:"sound transmission"',
  'abs:"sound radiation"',
  'abs:"cabin noise"',
  'abs:"acoustic metamaterial"',
  'abs:"active noise control"',
  'abs:"active vibration control"',
].join(" OR ");

/**
 * Starter venues. They are written to the database once and can then be
 * edited on the Venues page.
 *
 * - issns: comma-separated ISSNs. Papers are fetched from Crossref by ISSN.
 * - match_text: used when there is no ISSN (e.g. conferences). Crossref is
 *   searched by container title and only records whose journal/proceedings
 *   title contains this text are kept. For arXiv venues it is the arXiv search query.
 * - feed_url: optional RSS / table-of-contents feed of the journal, read in
 *   addition to Crossref (catches papers before their DOI is registered).
 */
export const DEFAULT_VENUES: DefaultVenue[] = [
  {
    name: "Journal of Sound and Vibration",
    issns: "0022-460X, 1095-8568",
    match_text: "",
    feed_url: "https://rss.sciencedirect.com/publication/science/0022460X",
  },
  {
    name: "Applied Acoustics",
    issns: "0003-682X, 1872-910X",
    match_text: "",
    feed_url: "https://rss.sciencedirect.com/publication/science/0003682X",
  },
  { name: "The Journal of the Acoustical Society of America (JASA)", issns: "0001-4966, 1520-8524", match_text: "" },
  {
    name: "Mechanical Systems and Signal Processing",
    issns: "0888-3270, 1096-1216",
    match_text: "",
    feed_url: "https://rss.sciencedirect.com/publication/science/08883270",
  },
  { name: "Inter-Noise (INTER-NOISE and NOISE-CON Congress Proceedings)", issns: "0736-2935", match_text: "" },
  { name: "AIAA/CEAS Aeroacoustics Conference", issns: "", match_text: "Aeroacoustics Conference" },
  arxivStarterVenue(),
];

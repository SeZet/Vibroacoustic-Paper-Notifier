/** Group members. A section is created for each name on first start. */
export const DEFAULT_PEOPLE = ["René", "Marco", "Martin", "Ray", "Sebastian"];

/**
 * Starter venues. They are written to the database once and can then be
 * edited on the Venues page.
 *
 * - issns: comma-separated ISSNs. Papers are fetched from Crossref by ISSN.
 * - match_text: used when there is no ISSN (e.g. conferences). Crossref is
 *   searched by container title and only records whose journal/proceedings
 *   title contains this text are kept.
 */
export const DEFAULT_VENUES: { name: string; issns: string; match_text: string }[] = [
  { name: "Journal of Sound and Vibration", issns: "0022-460X, 1095-8568", match_text: "" },
  { name: "Applied Acoustics", issns: "0003-682X, 1872-910X", match_text: "" },
  { name: "The Journal of the Acoustical Society of America (JASA)", issns: "0001-4966, 1520-8524", match_text: "" },
  { name: "Mechanical Systems and Signal Processing", issns: "0888-3270, 1096-1216", match_text: "" },
  { name: "Inter-Noise (INTER-NOISE and NOISE-CON Congress Proceedings)", issns: "0736-2935", match_text: "" },
  { name: "AIAA/CEAS Aeroacoustics Conference", issns: "", match_text: "Aeroacoustics Conference" },
];

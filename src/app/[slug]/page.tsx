import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getPersonBySlug,
  getRecommendations,
  getStatusCounts,
  type RecStatus,
} from "@/lib/db";
import { savePerson, scanNow, setRecommendationStatus } from "@/lib/actions";
import { SubmitButton } from "@/components/SubmitButton";
import { LocalTime } from "@/components/LocalTime";
import { SetupNotice } from "@/components/SetupNotice";

// "Scan now" runs as a server action on this page and can take a few minutes.
export const maxDuration = 300;

const TABS: { status: RecStatus; label: string; param: string }[] = [
  { status: "new", label: "Recommended", param: "recommended" },
  { status: "saved", label: "Saved", param: "saved" },
  { status: "deleted", label: "Deleted", param: "deleted" },
];

const EMPTY: Record<RecStatus, string> = {
  new: "No recommended papers right now.",
  saved: "Nothing saved yet. Use Save on a recommended paper to keep it here.",
  deleted: "Nothing deleted.",
};

export default async function PersonPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ list?: string }>;
}) {
  const { slug } = await params;
  const { list } = await searchParams;
  const tab = TABS.find((t) => t.param === list) ?? TABS[0];
  let person, recs, counts;
  try {
    person = await getPersonBySlug(decodeURIComponent(slug));
    if (person) {
      [recs, counts] = await Promise.all([getRecommendations(person.id, tab.status), getStatusCounts(person.id)]);
    }
  } catch (err) {
    return <SetupNotice error={err} />;
  }
  if (!person || !recs || !counts) notFound();

  const move = (id: number, status: RecStatus, label: string, className: string, title: string) => (
    <form action={setRecommendationStatus}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="slug" value={person.slug} />
      <input type="hidden" name="status" value={status} />
      <SubmitButton className={className} pendingText="…" title={title}>
        {label}
      </SubmitButton>
    </form>
  );

  return (
    <>
      <h1>{person.name}</h1>

      <section className="card">
        <h2>Research interests</h2>
        <form action={savePerson} className="stack">
          <input type="hidden" name="id" value={person.id} />
          <input type="hidden" name="slug" value={person.slug} />
          <textarea
            name="interests"
            rows={9}
            defaultValue={person.interests}
            placeholder={
              "Describe what you want to read about, in plain text or bullet points. For example:\n" +
              "- Sound transmission through aircraft fuselage panels and double walls\n" +
              "- Active and passive noise control in aircraft cabins\n" +
              "- Turbulent boundary layer excitation of structures\n" +
              "- Statistical energy analysis (SEA), FE/BEM vibroacoustic models"
            }
          />
          <div className="row">
            <label className="row">
              Check for new papers
              <select name="frequency" defaultValue={person.frequency}>
                <option value="weekly">weekly</option>
                <option value="monthly">monthly</option>
              </select>
            </label>
            <SubmitButton className="primary">Save</SubmitButton>
          </div>
        </form>
      </section>

      <section className="card">
        <div className="row spread">
          <h2>Papers</h2>
          <form action={scanNow}>
            <input type="hidden" name="id" value={person.id} />
            <input type="hidden" name="slug" value={person.slug} />
            <SubmitButton pendingText="Scanning… this can take a few minutes" title="Check for new papers since the last scan">
              Scan now
            </SubmitButton>
          </form>
        </div>
        <p className="muted small">
          {person.last_scan_at ? (
            <>
              Last scan <LocalTime iso={new Date(person.last_scan_at).toISOString()} />.{" "}
            </>
          ) : (
            "Not scanned yet. "
          )}
          {person.last_scan_status}
        </p>
        <p className="notice small">
          <span aria-hidden="true">⚠️</span> Each new scan moves unsaved recommendations to Deleted.
        </p>

        <nav className="tabs">
          {TABS.map((t) => (
            <Link
              key={t.param}
              href={t.param === "recommended" ? `/${person.slug}` : `/${person.slug}?list=${t.param}`}
              className={t.status === tab.status ? "active" : ""}
              scroll={false}
            >
              {t.label} <span className="tab-count">{counts[t.status]}</span>
            </Link>
          ))}
        </nav>

        {recs.length === 0 ? (
          <p className="empty">{EMPTY[tab.status]}</p>
        ) : (
          <ul className="papers">
            {recs.map((r) => (
              <li key={r.id}>
                <details>
                  <summary>
                    <span className="title">{r.title}</span>
                    <span className="meta">
                      {r.venue}
                      {r.published && ` · ${r.published}`}
                      <span className={`score s${Math.min(10, Math.max(1, r.score))}`} title="Relevance (1-10)">
                        {r.score}/10
                      </span>
                    </span>
                  </summary>
                  <div className="paper-body">
                    {r.authors && <p className="muted small">{r.authors}</p>}
                    <p className="reason">
                      <strong>Why:</strong> {r.reason}
                    </p>
                    {r.abstract ? (
                      <p className="abstract">{r.abstract}</p>
                    ) : (
                      <p className="abstract muted">No abstract available. Open the paper to read it on the publisher&apos;s site.</p>
                    )}
                    <div className="row">
                      <a className="button primary" href={r.url} target="_blank" rel="noopener noreferrer">
                        Open paper ↗
                      </a>
                      <span className="muted small">DOI {r.doi}</span>
                    </div>
                  </div>
                </details>
                <div className="item-actions">
                  {tab.status === "new" && (
                    <>
                      {move(r.id, "saved", "Save", "", "Keep this paper in your Saved list")}
                      {move(r.id, "deleted", "Delete", "ghost", "Not relevant: move to Deleted")}
                    </>
                  )}
                  {tab.status === "saved" && (
                    <>
                      {move(r.id, "new", "Unsave", "ghost", "Move back to Recommended")}
                      {move(r.id, "deleted", "Delete", "ghost", "Move to Deleted")}
                    </>
                  )}
                  {tab.status === "deleted" && (
                    <>
                      {move(r.id, "new", "Restore", "", "Move back to Recommended")}
                      {move(r.id, "saved", "Save", "ghost", "Move to Saved")}
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {recs.length >= 300 && <p className="muted small">Showing the 300 most recent.</p>}
      </section>

    </>
  );
}

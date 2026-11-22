import { notFound } from "next/navigation";
import { getPersonBySlug, getRecommendations } from "@/lib/db";
import { dismissRecommendation, savePerson, scanNow } from "@/lib/actions";
import { SubmitButton } from "@/components/SubmitButton";
import { LocalTime } from "@/components/LocalTime";
import { SetupNotice } from "@/components/SetupNotice";

// "Scan now" runs inside this page's server action and can take a few minutes.
export const maxDuration = 300;

export default async function PersonPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  let person, recs;
  try {
    person = await getPersonBySlug(decodeURIComponent(slug));
    recs = person ? await getRecommendations(person.id) : [];
  } catch (err) {
    return <SetupNotice error={err} />;
  }
  if (!person) notFound();

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
          <h2>Recommended papers</h2>
          <form action={scanNow}>
            <input type="hidden" name="id" value={person.id} />
            <input type="hidden" name="slug" value={person.slug} />
            <SubmitButton pendingText="Scanning… this can take a few minutes" title="Check for new papers now">
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

        {recs.length === 0 ? (
          <p className="empty">No open recommendations.</p>
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
                <form action={dismissRecommendation} className="remove">
                  <input type="hidden" name="id" value={r.id} />
                  <input type="hidden" name="slug" value={person.slug} />
                  <SubmitButton className="ghost" pendingText="…" title="Not relevant: remove from the list">
                    Remove
                  </SubmitButton>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

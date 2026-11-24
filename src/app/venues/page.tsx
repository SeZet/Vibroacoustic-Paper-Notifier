import { getVenues } from "@/lib/db";
import { addVenue, deleteVenue, toggleVenue, updateVenue } from "@/lib/actions";
import type { Venue } from "@/lib/db";
import { SubmitButton } from "@/components/SubmitButton";
import { SetupNotice } from "@/components/SetupNotice";

export default async function VenuesPage() {
  let venues;
  try {
    venues = await getVenues();
  } catch (err) {
    return <SetupNotice error={err} />;
  }
  return (
    <>
      <h1>Venues</h1>
      <p className="muted">
        New publications from these journals and conferences are checked for everyone. Journals are found in Crossref
        by ISSN. For a conference without an ISSN, give a piece of text that appears in its proceedings title instead.
      </p>
      <p className="muted">
        A journal can also have an RSS feed (its table of contents). The feed is read in addition to Crossref and
        catches papers that don&apos;t have a DOI yet; a paper found in both is listed once. arXiv venues search new
        preprints with an arXiv query.
      </p>

      <section className="card">
        <table className="venues">
          <thead>
            <tr>
              <th>Name</th>
              <th>Searched by</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {venues.map((v) => (
              <tr key={v.id} className={v.enabled ? "" : "disabled"}>
                <td>
                  {v.name}
                  <details className="edit">
                    <summary className="small muted">Edit</summary>
                    <VenueForm venue={v} />
                  </details>
                </td>
                <td className="small">
                  <Searched venue={v} />
                </td>
                <td className="actions">
                  <form action={toggleVenue}>
                    <input type="hidden" name="id" value={v.id} />
                    <SubmitButton className="ghost" pendingText="…">
                      {v.enabled ? "Pause" : "Resume"}
                    </SubmitButton>
                  </form>
                  <form action={deleteVenue}>
                    <input type="hidden" name="id" value={v.id} />
                    <SubmitButton className="ghost danger" pendingText="…">
                      Delete
                    </SubmitButton>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>Add a venue</h2>
        <VenueForm />
        <p className="muted small">
          You can look up a journal&apos;s ISSN on its website or at portal.issn.org. The RSS feed link is usually
          behind an RSS icon on the journal&apos;s homepage or latest-issue page. For Elsevier journals it is
          https://rss.sciencedirect.com/publication/science/ followed by the ISSN without the dash.
        </p>
      </section>
    </>
  );
}

function Searched({ venue: v }: { venue: Venue }) {
  if (v.kind === "arxiv") return <>arXiv query: {v.match_text}</>;
  return (
    <>
      {v.issns ? <>Crossref, ISSN {v.issns}</> : <>Crossref, title contains “{v.match_text}”</>}
      {v.feed_url && (
        <>
          <br />
          RSS feed:{" "}
          <a href={v.feed_url} target="_blank" rel="noopener noreferrer">
            {v.feed_url}
          </a>
        </>
      )}
    </>
  );
}

/** Add form, or edit form when a venue is given. */
function VenueForm({ venue }: { venue?: Venue }) {
  return (
    <form action={venue ? updateVenue : addVenue} className="stack">
      {venue && <input type="hidden" name="id" value={venue.id} />}
      <label>
        Type
        <select name="kind" defaultValue={venue?.kind ?? "journal"}>
          <option value="journal">Journal or conference</option>
          <option value="arxiv">arXiv search</option>
        </select>
      </label>
      <label>
        Name
        <input name="name" required defaultValue={venue?.name} placeholder="e.g. Journal of Fluids and Structures" />
      </label>
      <label>
        ISSN(s), comma separated (journals)
        <input name="issns" defaultValue={venue?.issns} placeholder="e.g. 0889-9746, 1095-8622" />
      </label>
      <label>
        Or, if there is no ISSN: text in the proceedings title. For arXiv: the search query
        <input name="match_text" defaultValue={venue?.match_text} placeholder='e.g. Aeroacoustics Conference, or abs:"cabin noise"' />
      </label>
      <label>
        RSS feed URL (optional, journals)
        <input
          name="feed_url"
          type="url"
          defaultValue={venue?.feed_url}
          placeholder="e.g. https://rss.sciencedirect.com/publication/science/08899746"
        />
      </label>
      <div>
        <SubmitButton className="primary">{venue ? "Save changes" : "Add venue"}</SubmitButton>
      </div>
    </form>
  );
}

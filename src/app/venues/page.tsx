import { getVenues } from "@/lib/db";
import { addVenue, deleteVenue, toggleVenue } from "@/lib/actions";
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
        New publications from these journals and conferences are checked for everyone. Journals are found by ISSN.
        For a conference without an ISSN, give a piece of text that appears in its proceedings title instead.
      </p>

      <section className="card">
        <table className="venues">
          <thead>
            <tr>
              <th>Name</th>
              <th>ISSN(s) or title text</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {venues.map((v) => (
              <tr key={v.id} className={v.enabled ? "" : "disabled"}>
                <td>{v.name}</td>
                <td className="small">{v.issns || <>title contains “{v.match_text}”</>}</td>
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
        <form action={addVenue} className="stack">
          <label>
            Name
            <input name="name" required placeholder="e.g. Journal of Fluids and Structures" />
          </label>
          <label>
            ISSN(s), comma separated
            <input name="issns" placeholder="e.g. 0889-9746, 1095-8622" />
          </label>
          <label>
            Or, if there is no ISSN: text in the proceedings title
            <input name="match_text" placeholder="e.g. Aeroacoustics Conference" />
          </label>
          <p className="muted small">
            You can look up a journal&apos;s ISSN on its website or at portal.issn.org.
          </p>
          <div>
            <SubmitButton className="primary">Add venue</SubmitButton>
          </div>
        </form>
      </section>
    </>
  );
}

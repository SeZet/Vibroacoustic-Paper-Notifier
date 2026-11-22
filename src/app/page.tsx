import Link from "next/link";
import { getPeople } from "@/lib/db";
import { LocalTime } from "@/components/LocalTime";
import { SetupNotice } from "@/components/SetupNotice";

export default async function Home() {
  let people;
  try {
    people = await getPeople();
  } catch (err) {
    return <SetupNotice error={err} />;
  }
  return (
    <>
      <section className="intro">
        <h1>New papers for the group</h1>
        <p>
          Each of us has a section with our research interests. Every week or month (your choice, in your section) the
          latest publications from our <Link href="/venues">venues</Link> are checked against those interests, and the
          ones worth a look show up in your list.
        </p>
      </section>
      <div className="grid">
        {people.map((p) => (
          <Link key={p.id} href={`/${p.slug}`} className="card person-card">
            <div className="person-head">
              <h2>{p.name}</h2>
              <span className={p.open_count > 0 ? "count has" : "count"}>
                {p.open_count} paper{p.open_count === 1 ? "" : "s"}
              </span>
            </div>
            <p className="muted small">
              {p.frequency === "monthly" ? "Monthly" : "Weekly"} scan
              {p.last_scan_at ? (
                <>
                  {" · last "}
                  <LocalTime iso={new Date(p.last_scan_at).toISOString()} />
                </>
              ) : (
                " · not scanned yet"
              )}
            </p>
            <p className="interests-preview">
              {p.interests.trim() ? p.interests.trim().slice(0, 220) + (p.interests.length > 220 ? "…" : "") : (
                <em>No research interests yet. Open the section to add them.</em>
              )}
            </p>
          </Link>
        ))}
      </div>
    </>
  );
}

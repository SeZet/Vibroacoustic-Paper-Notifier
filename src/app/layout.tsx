import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { getPeople } from "@/lib/db";
import { isAuthorized, PASSWORDS } from "@/lib/passwords";
import "./globals.css";

export const metadata: Metadata = {
  title: "Vibroacoustic Paper Notifier",
  description: "New publications in vibroacoustics, matched to each group member's research interests.",
};

export const dynamic = "force-dynamic";

async function Nav() {
  let people: { name: string; slug: string; open_count: number }[] = [];
  try {
    // Signed-out visitors (on the sign-in page) see no member names.
    const jar = await cookies();
    if (!(await isAuthorized("site", jar.get(PASSWORDS.site.cookie)?.value))) return null;
    people = await getPeople();
  } catch {
    // The page itself shows the setup notice.
  }
  return (
    <nav className="nav">
      {people.map((p) => (
        <Link key={p.slug} href={`/${p.slug}`}>
          {p.name}
          {p.open_count > 0 && <span className="pill">{p.open_count}</span>}
        </Link>
      ))}
      <Link href="/venues" className="nav-venues">
        Venues
      </Link>
      <Link href="/costs" className="nav-venues">
        API cost
      </Link>
      <Link href="/access" className="nav-venues">
        Tool access
      </Link>
    </nav>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="header">
          <div className="wrap">
            <Link href="/" className="brand">
              Vibroacoustic Paper Notifier
            </Link>
            <Nav />
          </div>
        </header>
        <main className="wrap">{children}</main>
        <footer className="wrap footer">
          Publications from Crossref, abstracts from Crossref, OpenAlex and Semantic Scholar, relevance judged by Claude.
        </footer>
      </body>
    </html>
  );
}

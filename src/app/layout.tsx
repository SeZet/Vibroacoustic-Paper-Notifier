import type { Metadata } from "next";
import Link from "next/link";
import { getPeople } from "@/lib/db";
import "./globals.css";

export const metadata: Metadata = {
  title: "Vibroacoustic Paper Notifier",
  description: "New publications in vibroacoustics, matched to each group member's research interests.",
};

export const dynamic = "force-dynamic";

async function Nav() {
  let people: { name: string; slug: string; open_count: number }[] = [];
  try {
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

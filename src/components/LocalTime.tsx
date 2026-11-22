"use client";

/** Shows a timestamp in the viewer's own time zone. */
export function LocalTime({ iso }: { iso: string }) {
  const d = new Date(iso);
  return (
    <time dateTime={iso} suppressHydrationWarning>
      {d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
    </time>
  );
}

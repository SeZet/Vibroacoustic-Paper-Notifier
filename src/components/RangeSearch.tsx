"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  cancelRangeAction,
  estimateRangeAction,
  rangeStepAction,
  resumeRangeAction,
  startRangeAction,
} from "@/lib/actions";
import type { RangeJob } from "@/lib/db";
import type { RangeEstimate } from "@/lib/range";

function isoDay(d: Date) {
  return d.toISOString().slice(0, 10);
}

function yearsAgo(n: number) {
  const d = new Date();
  d.setFullYear(d.getFullYear() - n);
  return isoDay(d);
}

function progress(job: RangeJob): number {
  const from = new Date(job.from_date).getTime();
  const to = new Date(job.to_date).getTime();
  const cur = new Date(job.cursor_date).getTime();
  if (job.status === "done") return 100;
  if (to <= from) return 0;
  return Math.max(0, Math.min(100, Math.round(((cur - from) / (to - from)) * 100)));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function RangeSearch({
  personId,
  hasInterests,
  initialJob,
  maxYears,
}: {
  personId: number;
  hasInterests: boolean;
  initialJob: RangeJob | null;
  maxYears: number;
}) {
  const router = useRouter();
  const [from, setFrom] = useState(yearsAgo(1));
  const [to, setTo] = useState(isoDay(new Date()));
  const [estimate, setEstimate] = useState<RangeEstimate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<RangeJob | null>(initialJob);
  const looping = useRef(false);

  const loop = useCallback(
    async (start: RangeJob) => {
      if (looping.current) return;
      looping.current = true;
      let current: RangeJob | null = start;
      try {
        while (looping.current && current && current.status === "running") {
          const before: string = current.cursor_date;
          const next: RangeJob | null = await rangeStepAction(current.id);
          if (!next) break;
          setJob(next);
          router.refresh();
          // Another tab may be working on this step; wait instead of asking again right away.
          if (next.status === "running" && next.cursor_date === before) await sleep(15_000);
          current = next;
        }
      } catch (err) {
        setError(`Connection lost (${err instanceof Error ? err.message : String(err)}). Reload the page to continue.`);
      } finally {
        looping.current = false;
      }
    },
    [router],
  );

  useEffect(() => {
    if (initialJob?.status === "running") void loop(initialJob);
    return () => {
      looping.current = false;
    };
    // Only on first render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onEstimate() {
    setBusy(true);
    setError(null);
    setEstimate(null);
    const result = await estimateRangeAction(from, to);
    setBusy(false);
    if ("error" in result) setError(result.error);
    else setEstimate(result);
  }

  async function onStart() {
    if (!estimate) return;
    setBusy(true);
    setError(null);
    const result = await startRangeAction(personId, estimate.from, estimate.to);
    setBusy(false);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setEstimate(null);
    setJob(result);
    router.refresh();
    void loop(result);
  }

  async function onResume() {
    if (!job) return;
    const j = await resumeRangeAction(job.id);
    if (j) {
      setJob(j);
      void loop(j);
    }
  }

  async function onCancel() {
    if (!job) return;
    looping.current = false;
    const j = await cancelRangeAction(job.id);
    setJob(j);
    router.refresh();
  }

  const active = job && (job.status === "running" || job.status === "paused");

  return (
    <div className="range">
      {active && job ? (
        <div className="stack">
          <p>
            Searching <strong>{job.from_date}</strong> to <strong>{job.to_date}</strong>
            {job.status === "running" ? <> (now at {job.cursor_date})</> : null}. Checked {job.checked} papers, found{" "}
            {job.found} so far.
          </p>
          <div className="bar" aria-label="Progress">
            <div style={{ width: `${progress(job)}%` }} />
          </div>
          {job.status === "running" ? (
            <p className="muted small">
              Keep this page open while it runs. If you close it, the search pauses and continues when you come back.
            </p>
          ) : (
            <p className="warn small">Paused: {job.message}</p>
          )}
          <div className="row">
            {job.status === "paused" && (
              <button type="button" className="primary" onClick={onResume}>
                Retry
              </button>
            )}
            <button type="button" className="ghost danger" onClick={onCancel}>
              Stop search
            </button>
          </div>
        </div>
      ) : (
        <div className="stack">
          {job?.status === "done" && (
            <p className="ok small">
              Last search ({job.from_date} to {job.to_date}) finished: checked {job.checked} papers, found {job.found}.
              {job.message ? ` Note: ${job.message}` : ""}
            </p>
          )}
          <div className="row">
            <label className="row">
              From
              <input type="date" value={from} max={to} onChange={(e) => (setFrom(e.target.value), setEstimate(null))} />
            </label>
            <label className="row">
              to
              <input type="date" value={to} min={from} onChange={(e) => (setTo(e.target.value), setEstimate(null))} />
            </label>
          </div>
          <div className="row small">
            Quick pick:
            {[1, 3, 5, 10].filter((n) => n <= maxYears).map((n) => (
              <button
                key={n}
                type="button"
                className="ghost"
                onClick={() => {
                  setFrom(yearsAgo(n));
                  setTo(isoDay(new Date()));
                  setEstimate(null);
                }}
              >
                last {n} year{n > 1 ? "s" : ""}
              </button>
            ))}
          </div>
          {!estimate && (
            <div>
              <button type="button" onClick={onEstimate} disabled={busy || !hasInterests}>
                {busy ? "Counting papers…" : "Check size and cost"}
              </button>
              {!hasInterests && <span className="muted small"> Add your research interests first.</span>}
            </div>
          )}
          {estimate && (
            <div className="estimate stack">
              <p>
                About <strong>{estimate.papers.toLocaleString()}</strong> papers were published in this window in the
                selected venues. Judging them costs roughly{" "}
                <strong>{estimate.costUsd < 1 ? "under 1 USD" : `${Math.ceil(estimate.costUsd)} USD`}</strong> of Claude
                API credit and takes about <strong>{estimate.minutes} minutes</strong>.
              </p>
              <details className="small muted">
                <summary>Per venue</summary>
                <ul>
                  {estimate.perVenue.map((v) => (
                    <li key={v.name}>
                      {v.name}: {v.count.toLocaleString()}
                    </li>
                  ))}
                </ul>
              </details>
              {estimate.warnings.map((w) => (
                <p key={w} className="warn small">
                  {w}
                </p>
              ))}
              <p className="muted small">
                Starting moves your current Recommended papers (except saved ones) to Deleted, like a regular scan.
                Papers you have already seen are skipped. Your weekly/monthly schedule is not affected.
              </p>
              <div className="row">
                <button type="button" className="primary" onClick={onStart} disabled={busy}>
                  {busy ? "Starting…" : "Start search"}
                </button>
                <button type="button" className="ghost" onClick={() => setEstimate(null)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      {error && <p className="warn small">{error}</p>}
    </div>
  );
}

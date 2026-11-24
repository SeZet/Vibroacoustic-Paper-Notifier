import { cookies } from "next/headers";
import { changeCostPassword, costLogin, costLogout, resetCosts } from "@/lib/actions";
import { COST_COOKIE, getCostSummary, isAuthorized, usingDefaultPassword } from "@/lib/costs";
import { SubmitButton } from "@/components/SubmitButton";
import { LocalTime } from "@/components/LocalTime";
import { SetupNotice } from "@/components/SetupNotice";

const PW_MESSAGES: Record<string, string> = {
  wrong: "The current password is not correct.",
  short: "The new password needs at least 4 characters.",
  mismatch: "The two new passwords do not match.",
  changed: "Password changed.",
};

function usd(n: number): string {
  return n < 0.01 && n > 0 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

function tokens(n: number): string {
  return n.toLocaleString("en-US");
}

export default async function CostsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; pw?: string }>;
}) {
  const { error, pw } = await searchParams;
  const jar = await cookies();
  let authorized, summary, isDefault;
  try {
    authorized = await isAuthorized(jar.get(COST_COOKIE)?.value);
    if (authorized) {
      [summary, isDefault] = await Promise.all([getCostSummary(), usingDefaultPassword()]);
    }
  } catch (err) {
    return <SetupNotice error={err} />;
  }

  if (!authorized || !summary) {
    return (
      <>
        <h1>API cost</h1>
        <section className="card">
          <form action={costLogin} className="stack narrow">
            <label>
              Password
              <input name="password" type="password" required autoFocus autoComplete="current-password" />
            </label>
            {error && <p className="danger small">Wrong password.</p>}
            <div>
              <SubmitButton className="primary" pendingText="Checking…">
                Open
              </SubmitButton>
            </div>
          </form>
        </section>
      </>
    );
  }

  return (
    <>
      <div className="row spread">
        <h1>API cost</h1>
        <form action={costLogout}>
          <SubmitButton className="ghost" pendingText="…">
            Sign out
          </SubmitButton>
        </form>
      </div>

      <section className="card">
        <p className="muted small">
          {summary.since ? (
            <>
              Total since the last reset on <LocalTime iso={summary.since} />
            </>
          ) : (
            "Total of all scans so far"
          )}
        </p>
        <p className="big-number">{usd(summary.cost)}</p>
        <p className="muted small">
          {summary.calls} Claude API call{summary.calls === 1 ? "" : "s"}, {tokens(summary.inputTokens)} input and{" "}
          {tokens(summary.outputTokens)} output tokens.
        </p>
        {summary.byModel.length > 1 && (
          <ul className="small">
            {summary.byModel.map((m) => (
              <li key={m.model}>
                {m.model}: {usd(m.cost)} ({m.calls} call{m.calls === 1 ? "" : "s"})
              </li>
            ))}
          </ul>
        )}
        <p className="muted small">
          Worked out by this site from the token counts Claude reports for each call, at Anthropic&apos;s list prices.
          It is an estimate: the Anthropic Console (Billing) shows the exact amount.
          {summary.firstLogged ? (
            <>
              {" "}
              Counting started on <LocalTime iso={summary.firstLogged} />; scans before that were not recorded.
            </>
          ) : (
            " Counting starts with the next scan; scans before this feature was added were not recorded."
          )}
        </p>
        <form action={resetCosts} className="row">
          <label className="row small">
            <input type="checkbox" name="confirm" required style={{ width: "auto" }} />I bought more credit, start
            counting from zero
          </label>
          <SubmitButton className="danger" pendingText="Resetting…">
            Reset to zero
          </SubmitButton>
        </form>
      </section>

      <section className="card">
        <h2>Change password</h2>
        {isDefault && (
          <p className="danger small">This page still uses the default password. Please choose your own.</p>
        )}
        {pw && PW_MESSAGES[pw] && <p className={pw === "changed" ? "small" : "danger small"}>{PW_MESSAGES[pw]}</p>}
        <form action={changeCostPassword} className="stack narrow">
          <label>
            Current password
            <input name="current" type="password" required autoComplete="current-password" />
          </label>
          <label>
            New password
            <input name="next" type="password" required minLength={4} autoComplete="new-password" />
          </label>
          <label>
            New password again
            <input name="repeat" type="password" required minLength={4} autoComplete="new-password" />
          </label>
          <div>
            <SubmitButton pendingText="Saving…">Change password</SubmitButton>
          </div>
        </form>
      </section>
    </>
  );
}

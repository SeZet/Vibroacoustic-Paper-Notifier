import { siteLogin } from "@/lib/actions";
import { SubmitButton } from "@/components/SubmitButton";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const { error, next } = await searchParams;
  return (
    <>
      <h1>Sign in</h1>
      <section className="card">
        <p className="muted small">This site is for the vibroacoustics group. Enter the group password to continue.</p>
        <form action={siteLogin} className="stack narrow">
          <input type="hidden" name="next" value={next ?? "/"} />
          <label>
            Password
            <input name="password" type="password" required autoFocus autoComplete="current-password" />
          </label>
          {error && <p className="danger small">Wrong password.</p>}
          <div>
            <SubmitButton className="primary" pendingText="Checking…">
              Sign in
            </SubmitButton>
          </div>
        </form>
      </section>
    </>
  );
}

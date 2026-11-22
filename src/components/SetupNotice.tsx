export function SetupNotice({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="card notice">
      <h2>The site is not fully set up yet</h2>
      <p>{message}</p>
      <p>
        See the <strong>Deploying on Vercel</strong> section of the README in the GitHub repository for the steps.
      </p>
    </div>
  );
}

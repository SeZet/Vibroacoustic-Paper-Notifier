import { SubmitButton } from "./SubmitButton";

const MESSAGES: Record<string, string> = {
  wrong: "The current password is not correct.",
  short: "The new password needs at least 4 characters.",
  mismatch: "The two new passwords do not match.",
  changed: "Password changed.",
};

/** Form to change one of the site's passwords. `status` is the ?pw= code the action redirects back with. */
export function PasswordForm({ action, status }: { action: (formData: FormData) => Promise<void>; status?: string }) {
  return (
    <>
      {status && MESSAGES[status] && (
        <p className={status === "changed" ? "small" : "danger small"}>{MESSAGES[status]}</p>
      )}
      <form action={action} className="stack narrow">
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
    </>
  );
}

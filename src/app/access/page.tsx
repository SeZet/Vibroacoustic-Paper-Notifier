import { changeSitePassword, siteLogout } from "@/lib/actions";
import { usingDefaultPassword } from "@/lib/passwords";
import { PasswordForm } from "@/components/PasswordForm";
import { SubmitButton } from "@/components/SubmitButton";
import { SetupNotice } from "@/components/SetupNotice";

export default async function AccessPage({ searchParams }: { searchParams: Promise<{ pw?: string }> }) {
  const { pw } = await searchParams;
  let isDefault;
  try {
    isDefault = await usingDefaultPassword("site");
  } catch (err) {
    return <SetupNotice error={err} />;
  }
  return (
    <>
      <div className="row spread">
        <h1>Tool access</h1>
        <form action={siteLogout}>
          <SubmitButton className="ghost" pendingText="…">
            Sign out
          </SubmitButton>
        </form>
      </div>
      <p className="muted">
        Everyone in the group signs in to this site with one shared password. Anyone signed in can change it here.
        After a change, everyone else has to sign in again with the new password, so tell the group.
      </p>
      <section className="card">
        <h2>Change the group password</h2>
        {isDefault && (
          <p className="danger small">The site still uses the default password. Please choose your own.</p>
        )}
        <PasswordForm action={changeSitePassword} status={pw} />
      </section>
    </>
  );
}

# Vibroacoustic Paper Notifier

A small website for our vibroacoustics group. Each member has a section where they describe their research interests. Every week or month (each person chooses), the site collects the newest publications from our journals and conferences, asks Claude which ones match each person's interests, and lists them in that person's section.

- Sections for René, Marco, Martin, Ray and Sebastian. Everyone can see every section.
- Write your interests in plain text or bullet points and pick **weekly** or **monthly**.
- Each recommendation shows the title and the journal or conference. Click it to see the abstract (when one is available) and why it was recommended.
- **Open paper** takes you to the publisher's page (via the DOI link), for example Elsevier, ASA or AIAA.
- Every section has three lists: **Recommended**, **Saved** and **Deleted**.
  - **Save** keeps a paper in your Saved list. Saved papers stay until you unsave or delete them.
  - **Delete** moves a paper to Deleted. **Restore** brings it back to Recommended.
  - **Each new scan moves whatever is still on your Recommended list (and not saved) to Deleted**, so Recommended always shows the latest scan's results. Nothing is lost: it's all in Deleted.
  - A paper is never recommended to you twice, even if you deleted it.
- **Scan now** runs a check immediately instead of waiting for the schedule. It covers the time since your last scan.
- The **Venues** page lists the journals and conferences that are checked. Anyone can add, pause or delete venues.

There is no login: anyone with the link can view and edit. Share the link only with the group.

## How it works

1. **Once a day** Vercel runs the scheduled job (`/api/cron`, 05:00 UTC). It only scans for people whose weekly or monthly scan is due.
2. **New publications** registered since that person's last scan are fetched from [Crossref](https://www.crossref.org/) for every enabled venue (journals by ISSN, conferences by proceedings title).
3. **Abstracts** come from Crossref when the publisher provides them, otherwise from [OpenAlex](https://openalex.org/) and then [Semantic Scholar](https://www.semanticscholar.org/). Some publishers (Elsevier in particular) don't share abstracts with these services, so some papers will show "No abstract available"; the **Open paper** link still works.
4. **Claude** reads each person's interests and the list of new papers (title, venue, abstract) and scores each paper from 1 to 10. Papers scoring 6 or more are added to that person's list.

Starter venues: Journal of Sound and Vibration, Applied Acoustics, JASA, Mechanical Systems and Signal Processing, Inter-Noise proceedings, and the AIAA/CEAS Aeroacoustics Conference.

## Deploying on Vercel

You need three free or cheap accounts: GitHub (you have it), [Vercel](https://vercel.com) and the [Anthropic Console](https://console.anthropic.com). It takes about 15 minutes. You don't need to install anything on your computer.

### 1. Get an Anthropic API key

Your Claude subscription (Pro/Max) does not include API access; the API is billed separately, pay as you go.

1. Sign in at [console.anthropic.com](https://console.anthropic.com).
2. Under **Billing**, add a payment method and buy some credit (10 USD is a good start). Setting a monthly spend limit there is a good idea.
3. Under **API Keys**, click **Create Key**, name it e.g. `paper-notifier`, and copy the key (it starts with `sk-ant-`). It is shown only once, so keep it somewhere safe until step 4.

### 2. Import the repository into Vercel

1. Sign up at [vercel.com](https://vercel.com) with **Continue with GitHub** (the free Hobby plan is enough).
2. Click **Add New… → Project**, find **Vibroacoustic-Paper-Notifier** and click **Import**. If it isn't listed, click **Adjust GitHub App Permissions** and give Vercel access to the repository.
3. Leave all build settings as they are and click **Deploy**. The first deploy works, but the site will say it is not set up yet. That's expected.

### 3. Add the database

1. In your Vercel project, open the **Storage** tab and click **Create Database**.
2. Choose **Neon** (Serverless Postgres), accept the defaults (the free plan is plenty; pick a region close to you, e.g. Frankfurt) and click **Create**.
3. Make sure it is connected to this project for all environments. Vercel then adds the `DATABASE_URL` setting automatically.

The tables, the five group sections and the starter venues are created automatically the first time the site is opened.

### 4. Add the settings (environment variables)

In the project go to **Settings → Environment Variables** and add:

| Name | Value |
|---|---|
| `ANTHROPIC_API_KEY` | The key from step 1 |
| `CRON_SECRET` | Any long random text, e.g. 40 random letters and digits. It stops strangers from triggering scans. |
| `CONTACT_EMAIL` | *(optional, recommended)* An email address. It's sent to Crossref and OpenAlex so they serve you from their faster pool. |

Optional extras:

| Name | What it does |
|---|---|
| `CLAUDE_MODEL` | Which Claude model judges relevance. Default `claude-opus-5-5` (best). `claude-sonnet-5-5` costs about half, `claude-haiku-5-5` much less. |
| `MIN_SCORE` | Minimum relevance (1 to 10) for a paper to be listed. Default `6`. Lower it for more suggestions, raise it for fewer. |
| `OPENALEX_API_KEY`, `SEMANTIC_SCHOLAR_API_KEY` | Free keys from those services raise their rate limits. Not required. |

### 5. Redeploy

Settings only take effect after a new deploy: open the **Deployments** tab, click the **⋯** menu on the latest deployment and choose **Redeploy**.

Open the site (the URL is shown on the project's overview page, something like `vibroacoustic-paper-notifier.vercel.app`). Each person then:

1. Opens their section, writes their research interests and picks weekly or monthly, then clicks **Save**.
2. Optionally clicks **Scan now** to get a first list right away (takes one to a few minutes).

From then on, scans run automatically. You can see the scheduled job under **Settings → Cron Jobs** in Vercel.

## Costs

- **Vercel** Hobby plan and **Neon** free plan: free for this use.
- **Crossref, OpenAlex, Semantic Scholar**: free.
- **Claude API**: depends on how many papers are published and the model. With the default model, expect very roughly 0.10 to 0.50 USD per person per scan for the starter venues (a monthly scan covers about four times as many papers as a weekly one, so the monthly total is similar). Switching `CLAUDE_MODEL` to `claude-sonnet-5-5` halves that; `claude-haiku-5-5` costs a small fraction. A large conference (e.g. when the Inter-Noise proceedings are published all at once) makes that one scan more expensive. You can see actual usage in the Anthropic Console.

## Changing things later

- **Group members**: add a name to `DEFAULT_PEOPLE` in `src/lib/defaults.ts` and commit; the section appears after the next deploy. (Removing a name from that list does not delete an existing section.)
- **Scan time**: edit the `schedule` in `vercel.json` (cron syntax, UTC). The Hobby plan allows one run per day.
- **How Claude judges papers**: the instructions are in `src/lib/rank.ts`.

## Troubleshooting

- **"The site is not fully set up yet"**: the database isn't connected or the deploy happened before it was. Do steps 3 and 5.
- **A scan says "ANTHROPIC_API_KEY is not set" or "Claude API calls failed"**: check the key in step 4, that you have credit in the Anthropic Console, and redeploy.
- **"Some venues could not be read"**: Crossref was temporarily unreachable for that venue. The next scan covers the gap, since each scan starts where the last successful one ended.
- **Scan now seems stuck**: a scan can take a few minutes. If the page times out, reload it; the result appears once the scan finishes.
- **"Checked X of Y new papers…"**: there were too many new papers to judge within Vercel's 5-minute limit (this can happen when a big conference proceedings appears at once). The rest are checked on the next scheduled run, or click Scan now again.

## Running it on your own computer (optional, for developers)

```bash
npm install
cp .env.example .env.local   # fill in DATABASE_URL (a Neon connection string) and ANTHROPIC_API_KEY
npm run dev                  # http://localhost:3000
```

To trigger the scheduled job locally: `curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron`.

Tech: Next.js (App Router) on Vercel, Neon Postgres via `@neondatabase/serverless`, Claude via `@anthropic-ai/sdk`.

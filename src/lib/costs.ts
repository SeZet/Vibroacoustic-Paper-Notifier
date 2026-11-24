import { ensureSchema, sql } from "./db";

/** USD per million tokens (Anthropic API list prices). */
interface Price {
  input: number;
  output: number;
  cacheRead: number;
}

const PRICES: Record<string, Price> = {
  "claude-fable-5-2": { input: 8, output: 40, cacheRead: 0.2 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 1 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1 },
};

function priceFor(model: string): Price {
  if (PRICES[model]) return PRICES[model];
  // Dated or prefixed ids, e.g. "claude-sonnet-4-6-20260101": use the longest known prefix.
  const key = Object.keys(PRICES)
    .filter((k) => model.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  // Unknown model: assume Opus 5.5 prices rather than counting it as free.
  return PRICES[key ?? "claude-opus-5-5"];
}

export interface Usage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

export function costOf(model: string, u: Usage): number {
  const p = priceFor(model);
  const input = u.input_tokens ?? 0;
  const output = u.output_tokens ?? 0; // includes thinking tokens
  const cacheWrite = u.cache_creation_input_tokens ?? 0; // 5-minute cache writes cost 1.25x input
  const cacheRead = u.cache_read_input_tokens ?? 0;
  return (input * p.input + cacheWrite * p.input * 1.25 + cacheRead * p.cacheRead + output * p.output) / 1_000_000;
}

/** Records the tokens one Claude API call used. Never throws: a logging problem must not fail a scan. */
export async function logUsage(model: string, u: Usage) {
  try {
    await sql`INSERT INTO api_usage (model, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, cost_usd)
      VALUES (${model}, ${u.input_tokens ?? 0}, ${u.output_tokens ?? 0}, ${u.cache_creation_input_tokens ?? 0},
        ${u.cache_read_input_tokens ?? 0}, ${costOf(model, u)})`;
  } catch (err) {
    console.error("Could not record API usage", err);
  }
}

export interface CostSummary {
  since: string | null;
  firstLogged: string | null;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  byModel: { model: string; calls: number; cost: number }[];
}

async function resetAt(): Promise<string | null> {
  const rows = await sql`SELECT value FROM meta WHERE key = 'cost_reset_at'`;
  return rows[0] ? String(rows[0].value) : null;
}

export async function getCostSummary(): Promise<CostSummary> {
  await ensureSchema();
  const since = await resetAt();
  const from = since ?? "1970-01-01T00:00:00Z";
  const [totals] = await sql`
    SELECT count(*)::int AS calls, COALESCE(sum(input_tokens + cache_write_tokens + cache_read_tokens), 0)::bigint AS input,
      COALESCE(sum(output_tokens), 0)::bigint AS output, COALESCE(sum(cost_usd), 0)::float8 AS cost
    FROM api_usage WHERE created_at > ${from}`;
  const byModel = await sql`
    SELECT model, count(*)::int AS calls, sum(cost_usd)::float8 AS cost
    FROM api_usage WHERE created_at > ${from} GROUP BY model ORDER BY cost DESC`;
  const [first] = await sql`SELECT min(created_at) AS first FROM api_usage`;
  return {
    since,
    firstLogged: first?.first ? new Date(first.first as string).toISOString() : null,
    calls: Number(totals.calls),
    inputTokens: Number(totals.input),
    outputTokens: Number(totals.output),
    cost: Number(totals.cost),
    byModel: byModel.map((r) => ({ model: String(r.model), calls: Number(r.calls), cost: Number(r.cost) })),
  };
}

export async function resetCostTotal() {
  await ensureSchema();
  const now = new Date().toISOString();
  await sql`INSERT INTO meta (key, value) VALUES ('cost_reset_at', ${now})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
}

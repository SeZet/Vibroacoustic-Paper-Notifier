import Anthropic from "@anthropic-ai/sdk";
import type { Paper } from "./sources";
import { logUsage } from "./costs";

export interface Match {
  paper: Paper;
  score: number;
  reason: string;
}

const BATCH_SIZE = 60;

export function modelName(): string {
  return process.env.CLAUDE_MODEL || "claude-opus-5-5";
}

const CONCURRENCY = 3;
const ABSTRACT_CHARS = 900;

const SYSTEM = `You help researchers in aircraft vibroacoustics keep up with the literature.
You receive one researcher's statement of research interests and a numbered list of newly published papers (title, venue, and abstract when available).
Judge how likely the researcher would want to read each paper, based on the topics, methods, applications, and aircraft context in their statement.

Scoring, 1-10:
- 9-10: directly on one of their stated topics
- 7-8: clearly related method or application they would likely want to know about
- 5-6: loosely related, maybe of interest
- 1-4: not relevant
Only list papers that score 5 or higher. Leave everything else out.
For each listed paper, give the reason in one short sentence that names which of their interests it relates to.
When there is no abstract, judge from the title and venue alone and be conservative.`;

const SCHEMA = {
  type: "object",
  properties: {
    matches: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          score: { type: "integer" },
          reason: { type: "string" },
        },
        required: ["id", "score", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["matches"],
  additionalProperties: false,
} as const;

function describe(p: Paper, id: number): string {
  const abstract = p.abstract
    ? p.abstract.length > ABSTRACT_CHARS
      ? `${p.abstract.slice(0, ABSTRACT_CHARS)}…`
      : p.abstract
    : "(no abstract available)";
  return `[${id}] ${p.title}\nVenue: ${p.venue}\nAbstract: ${abstract}`;
}

async function rankBatch(client: Anthropic, interests: string, batch: Paper[]): Promise<Match[]> {
  const list = batch.map((p, i) => describe(p, i)).join("\n\n");
  const response = await client.beta.messages.create({
    model: modelName(),
    max_tokens: 8000,
    // If the main model declines a request, the API retries it on a fallback model.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: SCHEMA as unknown as Record<string, unknown> },
    },
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: `<research_interests>\n${interests}\n</research_interests>\n\n<papers>\n${list}\n</papers>`,
      },
    ],
  });
  // response.model is the model that actually served the call (it can be the fallback).
  await logUsage(response.model || modelName(), response.usage);

  if (response.stop_reason === "refusal") return [];
  const text = response.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim();
  if (!text) return [];
  let parsed: { matches?: { id: number; score: number; reason: string }[] };
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const out: Match[] = [];
  for (const m of parsed.matches ?? []) {
    const paper = batch[m.id];
    if (!paper) continue;
    out.push({ paper, score: Math.max(1, Math.min(10, Math.round(m.score))), reason: m.reason });
  }
  return out;
}

export interface RankResult {
  /** Papers at or above MIN_SCORE, best first. */
  matches: Match[];
  /** Every paper Claude actually judged (batches that failed or were not reached are left out). */
  judged: Paper[];
}

/**
 * Asks Claude which of the papers match the researcher's interests.
 * Stops starting new batches after `deadline` (ms timestamp) so a call fits in
 * Vercel's time limit; the papers not judged can be handled in a later run.
 */
export async function rankPapers(interests: string, papers: Paper[], opts: { deadline?: number } = {}): Promise<RankResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set in the Vercel environment variables.");
  }
  if (papers.length === 0) return { matches: [], judged: [] };
  const client = new Anthropic({ maxRetries: 3 });
  const batches: Paper[][] = [];
  for (let i = 0; i < papers.length; i += BATCH_SIZE) batches.push(papers.slice(i, i + BATCH_SIZE));

  const results: Match[] = [];
  const judged: Paper[] = [];
  let failures = 0;
  let lastError: unknown = null;
  let next = 0;
  async function worker() {
    while (next < batches.length) {
      if (opts.deadline && Date.now() > opts.deadline) return;
      const batch = batches[next++];
      try {
        results.push(...(await rankBatch(client, interests, batch)));
        judged.push(...batch);
      } catch (err) {
        failures++;
        lastError = err;
        console.error("Ranking batch failed", err);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
  if (judged.length === 0 && failures > 0) {
    const detail = lastError instanceof Error ? ` (${lastError.message})` : "";
    throw new Error(`Claude API calls failed${detail}. Check the API key and credit balance.`);
  }

  const minScore = Number(process.env.MIN_SCORE) || 6;
  return { matches: results.filter((m) => m.score >= minScore).sort((a, b) => b.score - a.score), judged };
}

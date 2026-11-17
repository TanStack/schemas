// The production monitor: what the local 15-minute Claude Code loop did.
//
// `check` reads PostHog (MCP connection `posthog`, project 643425) for
// recurring ingest failures that no open issue or pull request covers.
// `fix` runs once per new failure and opens a fix pull request with the
// evidence. Workflow jobs cannot create issues, so the PR is the record.
// Review and merge are the factory's `review` agent and `autoMerge`;
// `.source/workflows/deploy.ts` deploys after the merge.
//
// Admin setup (people only): connect PostHog and give it to the check job:
//   src mcp tools posthog --agent workflow:monitor/check
import {
  agent,
  defineAgentWorkflow,
  manual,
  schedule,
  setup,
  z,
} from '@tanstack-source/ci'

const checkModel = {
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
} as const
const fixModel = { provider: 'anthropic', model: 'claude-opus-5-5' } as const

const failure = z.object({
  providerId: z.string(),
  event: z.string(),
  error: z.string(),
  count: z.number(),
  firstSeen: z.string(),
  lastSeen: z.string(),
  evidence: z.string(),
})

const CHECK_PROMPT = `You monitor the modelschemas Cloudflare Worker (this repository).

1. In PostHog, switch to project 643425 (modelschemas). Run this HogQL:
   SELECT event, properties.providerId AS p,
     coalesce(properties.reason, substring(toString(properties.error), 1, 200)) AS r,
     count() AS n, min(timestamp) AS earliest, max(timestamp) AS latest
   FROM events
   WHERE event IN ('ingest_failed', 'pricing_lost', 'update_storm')
     AND timestamp > now() - INTERVAL 6 HOUR
   GROUP BY event, p, r ORDER BY n DESC LIMIT 50
   Also list error-tracking issues active in the last 6 hours.

2. Keep only RECURRING failures: the same provider + error on at least 3
   polls (the models poll runs every 15 minutes). Drop:
   - one-off upstream 5xx, 429, timeouts and "Network connection lost";
   - by-design residuals: llmgateway pricing_lost parser_miss (discount,
     peak and image keys are refused on purpose, #588); huggingface
     "native recommendation section missing" (#673);
   - anything an open issue or open pull request already covers (search
     both by provider id and by the error text), or that a pull request
     merged in the last 24 hours fixed.

3. Answer with the list. For each failure give a short "evidence" text:
   the event, count, first and last timestamp, the exact error, and where
   in src/ the error is thrown if you can find it. An empty list is the
   normal answer.`

const FIX_RULES = `Repository rules (read CLAUDE.md first):
- Fail loud: never swallow an error or add a silent fallback. A source
  that changed shape throws with its location; a fact the source does
  not state is null, never guessed.
- No pricing fallbacks: a price is the provider's own published price or
  nothing.
- OpenRouter and models.dev are compare-only: never copy a fact from them.
- Catalog data lives in the database, not in hard-coded maps.
- Add a test with the exact upstream text or response that broke.
- Run pnpm run lint, pnpm run typecheck and pnpm run test on the files you
  changed before you open the pull request.`

export default defineAgentWorkflow('monitor', {
  // A few minutes after each 15-minute models poll ends.
  on: [schedule('7,22,37,52 * * * *'), manual()],
})
  .job('check', {
    output: z.object({ failures: z.array(failure) }),
    budget: { maxCostUsd: 0.5, maxMinutes: 15 },
    steps: [
      agent({
        name: 'Check PostHog',
        model: checkModel,
        prompt: CHECK_PROMPT,
        tools: ['read_file', 'list_files', 'search'],
        mcp: ['posthog'],
        output: 'job',
      }),
    ],
  })
  .job('fix', {
    needs: ['check'],
    if: (ctx) => ctx.needs.check.output.failures.length > 0,
    forEach: { job: 'check', path: 'failures' },
    permissions: { contents: 'write' },
    budget: { maxCostUsd: 5, maxMinutes: 90 },
    egress: ['registry.npmjs.org'],
    steps: [
      setup.node({ version: 24 }),
      setup.pnpm(),
      { name: 'Install', run: 'pnpm install --frozen-lockfile' },
      agent({
        name: 'Fix',
        model: fixModel,
        prompt: (ctx) =>
          `A recurring production ingest failure needs a fix.\n\n${JSON.stringify(ctx.item, null, 2)}\n\n` +
          `Find the root cause in src/, fix it, add a test, and open a pull request into main. ` +
          `Put the evidence above in the pull request body, and name the provider and error in the title. ` +
          `If the cause is upstream and nothing in this repository should change, open no pull request and say why.\n\n${FIX_RULES}`,
        tools: [
          'read_file',
          'list_files',
          'search',
          'run_command',
          'write_file',
          'open_pr',
        ],
      }),
    ],
  })

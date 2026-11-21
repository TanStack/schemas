// Weekly live probes (issue #717). Runs `pnpm run probe -- <provider>
// --write` for each chat probe provider, and opens a pull request on
// `probe/weekly` when a record file changed. A person reviews and merges
// it; nothing here merges. No change, no pull request.
//
// Each provider's key is an optional secret: with none, the probe script
// prints `skip <provider>: <KEY> is not set` and the run goes on. The
// script caps its own requests (MAX_PROBE_REQUESTS) and never prints a key.
//
// Admin setup (people only), one per provider below:
//   src secret set GROQ_API_KEY --env development --host api.groq.com --header Authorization < groq-key.txt
//
// Opt a provider in: add it to `chatProbes` in
// src/server/providers/probes/index.ts, then add its id to PROVIDERS, its
// key to `secrets` and its API host to `egress` here.
import {
  defineWorkflow,
  forge,
  manual,
  schedule,
  setup,
} from '@tanstack-source/ci'

const PROVIDERS = ['groq']
const BRANCH = 'probe/weekly'
const RECORDS = 'src/server/providers/probes/records'

export default defineWorkflow('probe', {
  // Mondays 03:17 UTC.
  on: [schedule('17 3 * * 1'), manual()],
}).job('probe', {
  secrets: { GROQ_API_KEY: { optional: true } },
  egress: ['registry.npmjs.org', 'api.groq.com'],
  permissions: { push: [BRANCH], pulls: 'create' },
  timeoutMinutes: 15,
  steps: [
    setup.node(),
    setup.pnpm(),
    { name: 'Install', run: 'pnpm install --frozen-lockfile' },
    {
      name: 'Probe',
      do: async (ctx) => {
        for (const provider of PROVIDERS) {
          await ctx.sh`pnpm run probe -- ${provider} --write --skip-missing-key`
        }
      },
    },
    {
      name: 'Open the pull request',
      do: async (ctx) => {
        // Only main feeds the weekly pull request: a manual run on another
        // ref would push that ref's commits into it.
        const ref = ctx.env.TANSTACK_SOURCE_REF ?? ''
        if (ref !== 'main' && ref !== 'refs/heads/main') {
          ctx.summary(
            `Run on ${ref || 'an unknown ref'}, not main: records left unpushed, no pull request.`,
          )
          return
        }
        // A git failure fails the job; it never reads as "no change".
        const status = await ctx.sh
          .nothrow`git status --porcelain -- ${RECORDS}`
        if (status.code !== 0) {
          throw new Error(`git status failed: ${status.stderr}`)
        }
        if (status.stdout.trim() === '') {
          ctx.summary('No probe record changed: no pull request.')
          return
        }
        await ctx.sh`git switch -C ${BRANCH}`
        await ctx.sh`git add -- ${RECORDS}`
        await ctx.sh`git -c user.name=modelschemas-probe -c user.email=probe@modelschemas.invalid commit -m ${'Refresh probe records'}`
        await ctx.sh`git push --force origin ${`HEAD:refs/heads/${BRANCH}`}`
        const client = forge(ctx)
        const [open] = await client.pulls.list({ head: BRANCH, state: 'open' })
        if (open) {
          ctx.summary(`Updated the open probe pull request #${open.number}.`)
          return
        }
        await client.pulls.create({
          title: 'Refresh probe records',
          head: BRANCH,
          base: 'main',
          body: 'The weekly probe run (.source/workflows/probe.ts) changed a record under src/server/providers/probes/records/. Each record holds the status and error message that stated its value. Review the evidence, then merge.',
        })
      },
    },
  ],
})

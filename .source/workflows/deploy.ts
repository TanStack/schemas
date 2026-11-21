// Deploy the Worker on every push to main. Replaces the Workers Builds
// connection that died with the repo move (#553).
//
// Runs only as a protected run (main needs a branch rule that requires a
// pull request) in the `production` CI environment. The forge holds
// CLOUDFLARE_API_TOKEN outside the container; the job sees a placeholder.
// The Worker's runtime secrets stay where they are (Doppler prd ->
// `pnpm run secrets:push`); this job does not touch them.
import { defineWorkflow, manual, push, setup } from '@tanstack-source/ci'

export default defineWorkflow('deploy', {
  // manual(): deploy main again with no new commit (`src workflow run deploy`).
  // A rerun cannot do it: it keeps the trust level of its first attempt.
  on: [push({ branches: ['main'] }), manual()],
}).job('deploy', {
  environment: 'production',
  secrets: { CLOUDFLARE_API_TOKEN: {} },
  // Public config. `secrets:build` reads the two VITE_PUBLIC_* names from
  // Doppler; wrangler reads CLOUDFLARE_ACCOUNT_ID.
  vars: [
    'CLOUDFLARE_ACCOUNT_ID',
    'VITE_PUBLIC_POSTHOG_PROJECT_TOKEN',
    'VITE_PUBLIC_POSTHOG_HOST',
  ],
  egress: [
    'registry.npmjs.org',
    'api.cloudflare.com',
    'registry.cloudflare.com',
  ],
  timeoutMinutes: 20,
  steps: [
    {
      // An unset variable is undefined, and a production build with no
      // PostHog values turns analytics off without an error. The same
      // check as scripts/build-with-secrets.ts.
      name: 'Check variables',
      run: 'for n in CLOUDFLARE_ACCOUNT_ID VITE_PUBLIC_POSTHOG_PROJECT_TOKEN VITE_PUBLIC_POSTHOG_HOST; do [ -n "$(printenv "$n")" ] || { echo "CI variable $n is not set (src variable set $n)" >&2; exit 1; }; done',
    },
    setup.node({ version: 24 }),
    setup.pnpm(),
    { name: 'Install', run: 'pnpm install --frozen-lockfile' },
    { name: 'Build', run: 'pnpm run build' },
    // D1 migrations, then wrangler deploy.
    { name: 'Deploy', run: 'pnpm run deploy:ci' },
  ],
})

// The `ci` job of .github/workflows/ci.yml, on the forge. Runs on every pull
// request, whatever its base, so a stacked pull request (never opened on
// GitHub) gets checks too. GitHub CI stays as it is; zizmor stays there.
//
// No secrets and no variables: a pull request run is someone's code.
import {
  defineWorkflow,
  manual,
  pullRequest,
  push,
  setup,
} from '@tanstack-source/ci'

export default defineWorkflow('ci', {
  // manual(): run a branch by hand (`src ci start ci --ref <branch>`).
  on: [pullRequest(), push({ branches: ['main'] }), manual()],
}).job('ci', {
  // Full history, so the changeset check finds the merge base with main.
  checkout: { depth: 0 },
  egress: ['registry.npmjs.org'],
  timeoutMinutes: 30,
  steps: [
    // Node from .node-version.
    setup.node(),
    setup.pnpm(),
    { name: 'Install', run: 'pnpm install --frozen-lockfile' },
    { name: 'Format check', run: 'pnpm run check' },
    { name: 'Lint', run: 'pnpm run lint' },
    { name: 'Typecheck', run: 'pnpm run typecheck' },
    // A PR that changes a published package needs a changeset (or
    // `pnpm exec changeset --empty`). The checkout has no remote branches:
    // fetch main from the forge's internal git host (no egress needed).
    {
      name: 'Changeset check',
      if: (ctx) => ctx.event === 'pull_request',
      run: 'git fetch --no-tags origin main:refs/remotes/origin/main && pnpm exec changeset status --since=origin/main',
    },
    // The committed client must match the spec.
    { name: 'Client drift check', run: 'pnpm run check:client' },
    { name: 'Test', run: 'pnpm run test' },
    { name: 'Build', run: 'pnpm run build' },
  ],
})

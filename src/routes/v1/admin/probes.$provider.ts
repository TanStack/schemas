import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { getDb } from '#/db/index.ts'
import { isAdminRequest, jsonError } from '#/server/admin.ts'
import { readProbeObservations } from '#/server/ingest/probe-facts.ts'
import { getProvider } from '#/server/providers/index.ts'

/** Read-only audit of the probe observations (issue #717). No write path. */
export const Route = createFileRoute('/v1/admin/probes/$provider')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        if (!isAdminRequest(request, env.ADMIN_KEY)) {
          return jsonError(
            401,
            'unauthorized',
            'Provide the admin key via X-Admin-Key or Authorization: Bearer.',
          )
        }
        if (!getProvider(params.provider)) {
          return jsonError(
            404,
            'unknown_provider',
            `Unknown provider '${params.provider}'. GET /v1/providers lists them.`,
          )
        }
        const model =
          new URL(request.url).searchParams.get('model') ?? undefined
        const observations = await readProbeObservations(
          getDb(env),
          params.provider,
          model,
        )
        return Response.json(
          { provider: params.provider, observations },
          { headers: { 'Cache-Control': 'no-store' } },
        )
      },
    },
  },
})

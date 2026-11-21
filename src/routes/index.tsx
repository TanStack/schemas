import { useEffect } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'

import { registerWebMcp } from '#/lib/webmcp.ts'
import { timeAgo } from '#/lib/time.ts'
import { EXAMPLES } from '#/lib/examples.ts'
import { UNCLASSIFIED } from '#/lib/completeness.ts'

import {
  ChangeSummary,
  CodePanel,
  SectionHead,
  SiteFooter,
  SiteNav,
  StatusDot,
} from '#/components/site.tsx'
import type { Completeness, ServiceStatus } from '#/server/status.ts'

interface DashboardChange {
  id: string
  type: string
  providerId: string
  subjectId: string
  summary: string
  createdAt: number
}

interface DashboardData {
  status: ServiceStatus
  changes: Array<DashboardChange>
}

const getDashboardData = createServerFn({ method: 'GET' }).handler(
  async (): Promise<DashboardData> => {
    const { env } = await import('cloudflare:workers')
    const { getDb } = await import('#/db/index.ts')
    const { getServiceStatus } = await import('#/server/status.ts')
    const { listChanges } = await import('#/server/changes-api.ts')

    const db = getDb(env, { replica: true })
    const [status, changesOutcome] = await Promise.all([
      getServiceStatus(db),
      // Updates are mostly router prices moving poll to poll; additions
      // are what a visitor wants to see first.
      listChanges(db, { type: 'model.added', limit: 8 }),
    ])
    return {
      status,
      changes: changesOutcome.ok
        ? changesOutcome.result.changes.map((c) => ({
            id: c.id,
            type: c.type,
            providerId: c.providerId,
            subjectId: c.subjectId,
            summary: c.summary,
            createdAt: c.createdAt,
          }))
        : [],
    }
  },
)

export const Route = createFileRoute('/')({
  loader: () => getDashboardData(),
  component: Landing,
})

const fmt = new Intl.NumberFormat('en-US')

/** Whole-percent coverage, or null when there is nothing to cover. */
const pct = (part: number, whole: number) =>
  whole > 0 ? Math.round((part / whole) * 100) : null
const showPct = (value: number | null) => (value === null ? '—' : `${value}%`)
/** "2026-10-07 05:15Z (3 polls)" for a status marker's tooltip. */
const since = (record: { since: number; polls: number }) =>
  `${new Date(record.since * 1000).toISOString().slice(0, 16).replace('T', ' ')}Z (${record.polls} ${record.polls === 1 ? 'poll' : 'polls'})`

/** An amber word beside the status dot; the detail is its tooltip and label. */
function Marker({ label, text }: { label: string; text: string }) {
  return (
    <span
      className="ml-2 cursor-help text-xs text-tok-amber"
      title={text}
      aria-label={text}
    >
      {label}
    </span>
  )
}

function completenessNote(c: Completeness): string {
  // Defensive: nothing `/v1/status` sends may throw in render.
  const silent = Array.isArray(c.silent) ? c.silent.join(', ') : ''
  if (c.needed === 0) {
    return `Nothing to fill across ${c.rows} models: this provider does not publish ${silent}`
  }
  return `${c.filled} of ${c.needed} facts filled across ${c.rows} models${silent ? `; not published by this provider: ${silent}` : ''}`
}

const UNSCORED_NOTE =
  'No current score: none computed yet, or the live models changed since the last poll scored them'

/** `chat 82%` / `video —` / `origin 3/5`, each with its own tooltip. */
function ScoreLine({
  label,
  value,
  title,
  href,
}: {
  label: string
  value: string
  title: string
  href?: string
}) {
  const body = (
    <>
      <span className="text-ink-faint">{label}</span> {value}
    </>
  )
  return (
    <li>
      {href ? (
        <a
          className="cursor-help text-ink-soft hover:text-tok-blue"
          href={href}
          title={title}
        >
          {body}
        </a>
      ) : (
        <span className="cursor-help text-ink-soft" title={title} tabIndex={0}>
          {body}
        </span>
      )}
    </li>
  )
}

/** The total, then one line per activity the provider serves, then origin links. */
function CompletenessCell({
  id,
  c,
  models,
}: {
  id: string
  c: Completeness
  models: number
}) {
  const activities = Object.entries(c.activities).sort(
    ([, a], [, b]) => b.rows - a.rows,
  )
  if (c.score === null && activities.length === 0) {
    return (
      <span
        className="cursor-help"
        title={models === 0 ? 'No live models' : UNSCORED_NOTE}
        tabIndex={0}
      >
        unscored
      </span>
    )
  }
  return (
    <>
      <span
        className="cursor-help font-semibold"
        title={
          c.score === null
            ? 'Nothing scored: no activity of these models has a fact set and none needs an origin link'
            : completenessNote(c)
        }
        tabIndex={0}
      >
        {c.score === null
          ? 'unscored'
          : showPct(Math.round(Number(c.score) * 100))}
      </span>
      <ul className="m-0 list-none p-0 text-xs">
        {activities.map(([name, a]) => (
          <ScoreLine
            key={name}
            label={name}
            value={a.score === null ? '—' : showPct(Math.round(a.score * 100))}
            title={
              a.score === null
                ? `${a.rows} ${name} models, not scored: this activity has no fact set`
                : `${name}: ${a.filled} of ${a.needed} facts filled across ${a.rows} models`
            }
            // `/models` filters by known activities only; `unclassified`
            // rows have none, so that line links to the whole provider.
            href={`/models?provider=${id}${name === UNCLASSIFIED ? '' : `&activity=${name}`}`}
          />
        ))}
        {c.originLink.need > 0 && (
          <ScoreLine
            label="origin"
            value={`${c.originLink.have}/${c.originLink.need}`}
            title={`${c.originLink.have} of ${c.originLink.need} models another provider also lists link to their origin row`}
          />
        )}
      </ul>
    </>
  )
}

function Landing() {
  const { status, changes } = Route.useLoaderData()
  // WebMCP (task 10.6): in-page tools for browsers that ship
  // navigator.modelContext; silently absent everywhere else.
  useEffect(() => {
    registerWebMcp()
  }, [])
  const totals = status.providers.reduce(
    (acc, p) => ({
      models: acc.models + p.counts.models,
      endpoints: acc.endpoints + p.counts.endpoints,
      schemas: acc.schemas + p.counts.schemas,
    }),
    { models: 0, endpoints: 0, schemas: 0 },
  )
  // Unweighted across providers, so one huge catalog can't swamp the rest.
  const pricePcts = status.providers
    .map((p) => pct(p.counts.priced, p.counts.models))
    .filter((v) => v !== null)
  const avgPrice = pricePcts.length
    ? Math.round(pricePcts.reduce((a, b) => a + b, 0) / pricePcts.length)
    : null
  const lastPolledAt = Math.max(
    0,
    ...status.providers.map((p) => p.lastPolledAt ?? 0),
  )
  const lastSyncedAt = Math.max(
    0,
    ...status.providers.map((p) => p.lastSyncedAt ?? 0),
  )

  return (
    <div className="min-h-screen text-ink">
      <SiteNav />

      <main className="mx-auto max-w-[1080px] px-6 pb-16">
        <header className="pt-13">
          <h1 className="m-0 mb-3 max-w-[30em] font-mono text-[clamp(22px,3.4vw,30px)] leading-[1.25] font-semibold tracking-[-0.01em] text-balance">
            Live request &amp; response schemas for every AI model API
            <span className="text-tok-blue">▌</span>
          </h1>
          <p className="m-0 mb-6 max-w-[40em] text-[14.5px] text-ink-soft">
            Which models exist right now, and what their payloads look like.
            JSON Schemas for {status.providers.length} providers, refreshed
            automatically, served as plain JSON over HTTP — no key needed for
            reads.
          </p>

          <CodePanel
            title="try it"
            copyText="curl https://modelschemas.com/v1/models?q=claude"
          >
            <code>
              <span className="prompt">$</span> curl{' '}
              <span className="cj-str">
                https://modelschemas.com/v1/models?q=claude
              </span>
              {'\n'}
              <span className="cj-dim">{'{'} </span>
              <span className="cj-key">"id"</span>
              <span className="cj-dim">: </span>
              <span className="cj-str">"anthropic-claude-sonnet-5"</span>
              <span className="cj-dim">, </span>
              <span className="cj-key">"rawId"</span>
              <span className="cj-dim">: </span>
              <span className="cj-str">"claude-sonnet-5"</span>
              <span className="cj-dim">, </span>
              <span className="cj-key">"lastSeenAt"</span>
              <span className="cj-dim">: </span>
              <span className="cj-num">{lastPolledAt || 1783408549}</span>
              <span className="cj-dim">, … {'}'}</span>
            </code>
          </CodePanel>

          <div className="mt-5 flex flex-wrap gap-2.5 font-mono text-[12.5px]">
            <a
              href="/models"
              className="rounded-[4px] border border-ink bg-ink px-3.5 py-2 text-paper transition-opacity hover:opacity-85"
            >
              GET /v1/models
            </a>
            <a
              href="/schemas"
              className="rounded-[4px] border border-rule-strong px-3.5 py-2 transition-colors hover:border-ink"
            >
              GET /v1/schemas
            </a>
            <a
              href="/docs"
              className="rounded-[4px] border border-rule-strong px-3.5 py-2 transition-colors hover:border-ink"
            >
              docs
            </a>
            <a
              href="/mcp"
              className="rounded-[4px] border border-rule-strong px-3.5 py-2 transition-colors hover:border-ink"
            >
              /mcp
            </a>
            <a
              href="/llms.txt"
              className="rounded-[4px] border border-rule-strong px-3.5 py-2 transition-colors hover:border-ink"
            >
              /llms.txt
            </a>
          </div>

          <div className="hairline mt-11 flex flex-wrap gap-x-5 gap-y-2 border-y py-3 font-mono text-xs text-ink-soft">
            <span className="inline-flex items-center gap-2">
              <span className="pulse-dot bg-tok-green" />
              <span className="text-tok-green">live</span>
            </span>
            <span>
              <b className="font-semibold text-ink tabular-nums">
                {status.providers.length}
              </b>{' '}
              providers
            </span>
            <span>
              <b className="font-semibold text-ink tabular-nums">
                {fmt.format(totals.models)}
              </b>{' '}
              models
            </span>
            <span>
              <b className="font-semibold text-ink tabular-nums">
                {fmt.format(totals.endpoints)}
              </b>{' '}
              endpoints
            </span>
            <span>
              <b className="font-semibold text-ink tabular-nums">
                {fmt.format(totals.schemas)}
              </b>{' '}
              schema versions
            </span>
            <span>
              <b className="font-semibold text-ink tabular-nums">
                {showPct(avgPrice)}
              </b>{' '}
              priced, avg per provider
            </span>
            <span>
              polled{' '}
              <b className="font-semibold text-ink">
                {timeAgo(lastPolledAt, status.time)}
              </b>{' '}
              · specs synced{' '}
              <b className="font-semibold text-ink">
                {timeAgo(lastSyncedAt, status.time)}
              </b>
            </span>
          </div>
        </header>

        <section>
          <SectionHead
            title="Providers"
            aside={
              <a className="press-link" href="/v1/providers">
                GET /v1/providers →
              </a>
            }
          />
          <div className="figure overflow-x-auto">
            <table className="dtable dtable-cards">
              <thead>
                <tr>
                  <th>provider</th>
                  <th>status</th>
                  <th className="num">models</th>
                  <th className="num">endpoints</th>
                  <th className="num">schemas</th>
                  <th className="num" title="Share of models with a price card">
                    priced
                  </th>
                  <th
                    className="num"
                    title="Completeness: the share of the facts @tanstack/ai-models needs that are filled for this provider's models. Chat rows are scored on the chat facts; image, video and audio rows on price, endpoint and input and output modalities; a row with no activity is a gap; a row whose id another provider also lists needs an origin link. Facts the provider does not publish are left out. Below the total: one score per activity, then origin links filled of needed."
                  >
                    complete
                  </th>
                  <th className="num">polled</th>
                  <th className="num">synced</th>
                </tr>
              </thead>
              <tbody>
                {status.providers.map((p) => (
                  <tr key={p.id}>
                    <td className="font-medium">
                      <a
                        className="text-ink hover:text-tok-blue"
                        href={`/models?provider=${p.id}`}
                      >
                        {p.displayName}
                      </a>
                    </td>
                    <td>
                      <StatusDot status={p.status} />
                      {p.docsFailing && (
                        <Marker
                          label="docs"
                          text={`docs failing since ${since(p.docsFailing)}: ${[p.docsFailing.sources[0], String(p.docsFailing.error).slice(0, 160)].filter(Boolean).join(' — ')}`}
                        />
                      )}
                      {p.priceClearsRefused && (
                        <Marker
                          label="prices"
                          text={`price clears refused since ${since(p.priceClearsRefused)}: ${p.priceClearsRefused.refused} of ${p.priceClearsRefused.priced} stored prices kept`}
                        />
                      )}
                      {p.updateStorm && (
                        <Marker
                          label="updates"
                          text={`update storm since ${since(p.updateStorm)}: ${p.updateStorm.updated} of ${p.updateStorm.live} live rows updated in one poll`}
                        />
                      )}
                    </td>
                    <td className="num" data-label="models">
                      {fmt.format(p.counts.models)}
                    </td>
                    <td className="num" data-label="endpoints">
                      {fmt.format(p.counts.endpoints)}
                    </td>
                    <td className="num" data-label="schemas">
                      {p.counts.schemas > 0 ? (
                        <a
                          className="text-ink hover:text-tok-blue"
                          href={`/schemas?provider=${p.id}`}
                        >
                          {fmt.format(p.counts.schemas)}
                        </a>
                      ) : (
                        fmt.format(p.counts.schemas)
                      )}
                    </td>
                    <td className="num" data-label="priced">
                      {showPct(pct(p.counts.priced, p.counts.models))}
                    </td>
                    <td className="num" data-label="complete">
                      <CompletenessCell
                        id={p.id}
                        c={p.completeness}
                        models={p.counts.models}
                      />
                    </td>
                    <td className="num text-ink-faint" data-label="polled">
                      {timeAgo(p.lastPolledAt, status.time)}
                    </td>
                    <td className="num text-ink-faint max-[899px]:hidden">
                      {timeAgo(p.lastSyncedAt, status.time)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section>
          <SectionHead
            title="New models"
            aside={
              <a className="press-link" href="/changes?type=model.added">
                all new models →
              </a>
            }
          />
          {changes.length === 0 ? (
            <p className="font-mono text-sm text-ink-faint">
              no new models yet — the next cron poll will populate this list.
            </p>
          ) : (
            <>
              <div className="figure overflow-x-auto">
                <table className="dtable">
                  <tbody>
                    {changes.map((change) => (
                      <tr key={change.id}>
                        <td className="font-mono text-xs whitespace-nowrap text-ink-faint">
                          {timeAgo(change.createdAt, status.time)}
                        </td>
                        <td className="max-w-[38em] truncate">
                          <ChangeSummary change={change} />
                        </td>
                        <td className="font-mono text-xs text-ink-faint max-sm:hidden">
                          {change.providerId}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2.5 font-mono text-xs text-ink-faint">
                <a className="press-link" href="/changes">
                  every change: GET /v1/changes
                </a>{' '}
                · subscribe with a webhook to get these pushed —{' '}
                <a className="press-link" href="/docs">
                  POST /v1/subscriptions
                </a>
              </p>
            </>
          )}
        </section>

        <section>
          <SectionHead
            title="Examples"
            aside={
              <a className="press-link" href="/examples">
                /examples →
              </a>
            }
          />
          <div className="figure overflow-x-auto">
            <table className="dtable">
              <tbody>
                {EXAMPLES.map((example) => (
                  <tr key={example.slug}>
                    <td className="font-mono text-xs whitespace-nowrap">
                      <a
                        className="press-link"
                        href={`/examples/${example.slug}/`}
                      >
                        {example.slug}
                      </a>
                    </td>
                    <td className="max-w-[38em]">{example.blurb}</td>
                    <td className="font-mono text-xs whitespace-nowrap text-ink-faint max-sm:hidden">
                      {example.package}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  )
}

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import api from '../api.js'
import {
  CARD,
  TH,
  TH_NUM,
  Badge,
  CATEGORY_BADGE,
  Avatar,
  Sparkline,
  SkeletonStatRow,
  SkeletonTable,
  SkeletonBlock,
  ErrorBanner,
  getErrorMessage,
} from '../ui.jsx'

// Dashboard is mission control: what needs a human right now, then a fast
// read on the funnel, the campaign roster, and LinkedIn — one screen for the
// healthy case, no scrolling on a laptop.

const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString())

const STATUS_TONE = { active: 'green', draft: 'grey', paused: 'yellow', completed: 'grey' }

const RUN_JOB_LABELS = {
  lead_processor: 'hourly',
  manual_process: 'manual',
  lead_replenisher: 'sourcing',
}

function formatDateTime(value) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function hoursAgo(value) {
  if (!value) return null
  const ms = Date.now() - new Date(value).getTime()
  return Number.isFinite(ms) ? Math.round(ms / 3_600_000) : null
}

// Week-over-week delta as {text, tone} for a StatCard.
function deltaMeta(delta) {
  if (!delta || delta.this_week == null) return null
  const diff = delta.this_week - (delta.last_week ?? 0)
  const arrow = diff > 0 ? '▲' : diff < 0 ? '▼' : '='
  const tone = diff > 0 ? 'green' : diff < 0 ? 'red' : 'grey'
  return { text: `${arrow}${diff !== 0 ? Math.abs(diff) : ''}`, tone }
}

function FunnelStatCard({ label, delta }) {
  const meta = deltaMeta(delta)
  const trend = delta ? [delta.last_week ?? 0, delta.this_week ?? 0] : []
  return (
    <div className="min-w-0 flex-1">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-[#6B7280]">
          {label}
        </span>
        {trend.length > 1 && <Sparkline data={trend} width={48} height={18} />}
      </div>
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-2xl font-extrabold tabular-nums tracking-tight text-[#111827]">
          {fmt(delta?.total)}
        </span>
        {meta && (
          <span
            className={`text-xs font-semibold ${
              meta.tone === 'green' ? 'text-[#047857]' : meta.tone === 'red' ? 'text-red-600' : 'text-[#6B7280]'
            }`}
          >
            {meta.text}
          </span>
        )}
      </div>
    </div>
  )
}

// Alert-center severity styling — icon badge + tinted panel, colour used
// semantically only (red=broken, amber=attention, violet=brand/actionable).
const SEVERITY_STYLES = {
  red: { panel: 'border-red-200 bg-red-50', iconBg: 'bg-red-100 text-red-600' },
  amber: { panel: 'border-amber-200 bg-amber-50', iconBg: 'bg-amber-100 text-amber-600' },
  violet: { panel: 'border-violet-200 bg-violet-50', iconBg: 'bg-violet-100 text-violet-600' },
}

const ALERT_ICONS = {
  replies: (
    <path d="M4 4h16v11H8l-4 4V4z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  ),
  inactive: (
    <>
      <path d="M12 2 1 21h22L12 2z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M12 9v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="12" cy="16.5" r="0.9" fill="currentColor" />
    </>
  ),
  zeroSend: (
    <>
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M10 9v6M14 9v6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </>
  ),
  stuck: (
    <>
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 7v5l3 3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  exhausted: (
    <>
      <path d="M4 12a8 8 0 0 1 14-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M20 12a8 8 0 0 1-14 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M4 4v4h4M20 20v-4h-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
}

function AlertIcon({ type }) {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
      {ALERT_ICONS[type]}
    </svg>
  )
}

// One "needs attention" sub-list — only rendered when it has entries, so a
// healthy dashboard collapses to nothing but the "All clear" banner.
function AttentionGroup({ type, severity = 'amber', title, children }) {
  const s = SEVERITY_STYLES[severity] || SEVERITY_STYLES.amber
  return (
    <div className={`rounded-xl border p-4 ${s.panel}`}>
      <div className="mb-2.5 flex items-center gap-2.5">
        <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${s.iconBg}`}>
          <AlertIcon type={type} />
        </span>
        <p className="text-xs font-bold uppercase tracking-wider text-[#111827]">{title}</p>
      </div>
      <ul className="space-y-1.5 pl-9">{children}</ul>
    </div>
  )
}

function DashboardSkeleton() {
  return (
    <section className="mx-auto max-w-7xl">
      <header className="mb-5">
        <div className="h-9 w-48 animate-pulse rounded bg-[#E5E7EB]" />
        <div className="mt-2 h-4 w-64 animate-pulse rounded bg-[#E5E7EB]" />
      </header>
      <div className="space-y-4">
        <SkeletonBlock className="h-20 w-full" />
        <SkeletonStatRow count={4} />
        <SkeletonTable rows={6} cols={6} />
      </div>
    </section>
  )
}

function Dashboard() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [campaigns, setCampaigns] = useState([])
  const [funnel, setFunnel] = useState(null)
  const [processHistory, setProcessHistory] = useState({})
  const [attention, setAttention] = useState(null)

  const [statusUpdatingId, setStatusUpdatingId] = useState(null)
  const [statusError, setStatusError] = useState(null)

  const [resumingId, setResumingId] = useState(null)
  const [resumeError, setResumeError] = useState(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const [campaignsRes, funnelRes, runsRes, attentionRes] = await Promise.all([
        api.get('/campaigns'),
        api.get('/funnel'),
        api.get('/campaigns/process-runs'),
        api.get('/dashboard/needs-attention'),
      ])
      setCampaigns(campaignsRes.data || [])
      setFunnel(funnelRes.data)
      setProcessHistory(runsRes.data || {})
      setAttention(attentionRes.data)
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  async function handleSetStatus(campaign, status) {
    setStatusUpdatingId(campaign.id)
    setStatusError(null)
    try {
      await api.patch(`/campaigns/${campaign.id}/status`, { status })
      await load()
    } catch (err) {
      setStatusError(getErrorMessage(err))
    } finally {
      setStatusUpdatingId(null)
    }
  }

  async function handleResume(campaignId) {
    setResumingId(campaignId)
    setResumeError(null)
    try {
      await api.post(`/campaigns/${campaignId}/resume`)
      await load()
    } catch (err) {
      setResumeError(getErrorMessage(err))
    } finally {
      setResumingId(null)
    }
  }

  if (loading) return <DashboardSkeleton />
  if (error) {
    return (
      <section className="mx-auto max-w-7xl">
        <ErrorBanner message={error} onRetry={load} />
      </section>
    )
  }

  const funnelByCampaign = new Map((funnel?.campaigns || []).map((c) => [c.id, c]))
  const healthByCampaign = new Map((attention?.campaignHealth || []).map((h) => [h.id, h]))

  const hasAttention =
    attention &&
    (attention.unhandledReplies.length > 0 ||
      attention.inactiveCampaigns.length > 0 ||
      attention.zeroSendCampaigns.length > 0 ||
      attention.stuckLeads.length > 0 ||
      (attention.exhaustedSources?.length ?? 0) > 0)

  const linkedinTotals = funnel?.totals?.linkedin
  const hasLinkedinActivity = (linkedinTotals?.queued?.total ?? 0) > 0

  return (
    <section className="mx-auto max-w-7xl">
      <header className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-[#111827]">Dashboard</h1>
          <p className="mt-1 text-sm text-[#6B7280]">Mission control for the Safely AI SDR.</p>
        </div>
        <button
          type="button"
          onClick={load}
          className="rounded-full border border-[#E5E7EB] bg-white px-4 py-1.5 text-sm font-semibold text-[#111827] transition hover:bg-[#F3F4F6]"
        >
          Refresh
        </button>
      </header>

      {statusError && (
        <div className="mb-4">
          <ErrorBanner message={statusError} />
        </div>
      )}

      {resumeError && (
        <div className="mb-4">
          <ErrorBanner message={resumeError} />
        </div>
      )}

      <div className="space-y-4">
        {/* ── 1. NEEDS ATTENTION — alert center ──────────────────────────── */}
        <div>
          <h2 className="mb-2 text-xs font-bold uppercase tracking-wider text-[#6B7280]">
            Needs attention
          </h2>
          {!hasAttention ? (
            <div className="flex items-center gap-2 rounded-xl border border-[#A7F3D0] bg-[#ECFDF5] px-4 py-3 text-sm font-semibold text-[#047857]">
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M20 6 9 17l-5-5" />
              </svg>
              All clear
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {attention.unhandledReplies.length > 0 && (
                <AttentionGroup type="replies" severity="violet" title={`Unhandled replies (${attention.unhandledReplies.length})`}>
                  {attention.unhandledReplies.slice(0, 5).map((r) => (
                    <li key={r.lead_id} className="flex items-center justify-between gap-2 text-sm">
                      <span className="flex min-w-0 items-center gap-2 truncate text-[#111827]">
                        <Avatar name={r.company_name || r.contact_name || '?'} size="sm" />
                        <span className="truncate">
                          <span className="font-semibold">{r.contact_name || 'Unknown'}</span>
                          {' @ '}
                          {r.company_name}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        {r.category && (
                          <Badge tone={CATEGORY_BADGE[r.category]?.tone || 'grey'}>
                            {CATEGORY_BADGE[r.category]?.label || r.category}
                          </Badge>
                        )}
                        <Link to="/replies" className="text-xs font-semibold text-[#7C3AED] hover:underline">
                          View →
                        </Link>
                      </span>
                    </li>
                  ))}
                  {attention.unhandledReplies.length > 5 && (
                    <li className="text-xs text-[#6B7280]">
                      +{attention.unhandledReplies.length - 5} more —{' '}
                      <Link to="/replies" className="font-semibold text-[#7C3AED] hover:underline">
                        see Replies
                      </Link>
                    </li>
                  )}
                </AttentionGroup>
              )}

              {attention.inactiveCampaigns.length > 0 && (
                <AttentionGroup type="inactive" severity="red" title={`Active locally, but not sending in Instantly (${attention.inactiveCampaigns.length})`}>
                  {attention.inactiveCampaigns.map((c) => (
                    <li key={c.id} className="flex items-center justify-between gap-2 text-sm">
                      <span className="flex min-w-0 items-center gap-2 truncate font-semibold text-[#111827]">
                        <Avatar name={c.name} size="sm" />
                        <span className="truncate">{c.name}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <span className="text-xs text-[#6B7280]">{c.reason}</span>
                        {c.resumable && (
                          <button
                            type="button"
                            onClick={() => handleResume(c.id)}
                            disabled={resumingId === c.id}
                            title={`Live Instantly status: ${c.instantlyStatusLabel}`}
                            className="rounded-full border border-red-200 bg-red-50 px-3 py-1 text-xs font-semibold text-red-700 transition hover:bg-red-100 disabled:opacity-50"
                          >
                            {resumingId === c.id
                              ? 'Resuming…'
                              : c.instantlyStatus === -2
                                ? 'Resume from bounce protect'
                                : 'Resume sending'}
                          </button>
                        )}
                      </span>
                    </li>
                  ))}
                </AttentionGroup>
              )}

              {attention.zeroSendCampaigns.length > 0 && (
                <AttentionGroup type="zeroSend" severity="amber" title={`0 sends in the last 48h, while active (${attention.zeroSendCampaigns.length})`}>
                  {attention.zeroSendCampaigns.map((c) => (
                    <li key={c.id} className="flex items-center justify-between gap-2 text-sm">
                      <span className="flex min-w-0 items-center gap-2 truncate font-semibold text-[#111827]">
                        <Avatar name={c.name} size="sm" />
                        <span className="truncate">{c.name}</span>
                      </span>
                      <span className="shrink-0 text-xs text-[#6B7280]">
                        {c.last_sent_at ? `last sent ${formatDateTime(c.last_sent_at)}` : 'never sent'}
                      </span>
                    </li>
                  ))}
                </AttentionGroup>
              )}

              {attention.stuckLeads.length > 0 && (
                <AttentionGroup type="stuck" severity="amber" title="Stuck leads (waiting on 'new' > 24h)">
                  {attention.stuckLeads.map((s) => (
                    <li key={s.campaign_id ?? 'none'} className="flex items-center justify-between gap-2 text-sm">
                      <span className="flex min-w-0 items-center gap-2 truncate font-semibold text-[#111827]">
                        <Avatar name={s.campaign_name || 'No campaign'} size="sm" />
                        <span className="truncate">{s.campaign_name || 'No campaign'}</span>
                      </span>
                      <span className="shrink-0 text-xs text-[#6B7280]">
                        {s.count} lead{s.count === 1 ? '' : 's'}, longest wait {hoursAgo(s.oldest_new_at)}h
                      </span>
                    </li>
                  ))}
                </AttentionGroup>
              )}

              {(attention.exhaustedSources?.length ?? 0) > 0 && (
                <AttentionGroup
                  type="exhausted"
                  severity={attention.exhaustedSources.some((e) => e.fallbackStatus === 'unavailable') ? 'red' : 'amber'}
                  title={`Source exhausted (${attention.exhaustedSources.length})`}
                >
                  {attention.exhaustedSources.map((e) => (
                    <li key={e.id} className="flex items-center justify-between gap-2 text-sm">
                      <span className="flex min-w-0 items-center gap-2 truncate font-semibold text-[#111827]">
                        <Avatar name={e.name} size="sm" />
                        <span className="truncate">{e.name}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <span className="text-xs text-[#6B7280]">
                          {e.primaryProvider} dry since {formatDateTime(e.exhaustedAt)}
                        </span>
                        <Badge tone={e.fallbackStatus === 'active' ? 'green' : 'red'}>
                          {e.fallbackStatus === 'active' ? `fallback: ${e.secondaryProvider}` : 'no fallback'}
                        </Badge>
                      </span>
                    </li>
                  ))}
                </AttentionGroup>
              )}
            </div>
          )}
        </div>

        {/* ── 2. FUNNEL SNAPSHOT ─────────────────────────────────────────── */}
        {funnel && (
          <div className={`${CARD} p-4`}>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-xs font-bold uppercase tracking-wider text-[#6B7280]">
                Funnel snapshot · all campaigns
              </h2>
              <Link to="/funnel" className="text-xs font-semibold text-[#7C3AED] hover:underline">
                View full funnel →
              </Link>
            </div>
            <div className="flex flex-wrap gap-6">
              <FunnelStatCard label="Sourced" delta={funnel.totals.email.sourced} />
              <FunnelStatCard label="Emailed" delta={funnel.totals.email.emailed} />
              <FunnelStatCard label="Replied" delta={funnel.totals.email.replied} />
              <FunnelStatCard label="Meetings" delta={funnel.totals.email.booked} />
            </div>
          </div>
        )}

        {/* ── 3. CAMPAIGNS AT A GLANCE ───────────────────────────────────── */}
        <div className={`overflow-x-auto ${CARD}`}>
          <table className="min-w-full">
            <thead className="border-b border-[#E5E7EB]">
              <tr>
                <th className={TH}>Campaign</th>
                <th className={TH}>Ours</th>
                <th className={TH}>Instantly</th>
                <th className={TH_NUM}>Leads</th>
                <th className={TH_NUM}>Sent</th>
                <th className={TH_NUM}>Replies</th>
                <th className={TH}>Last run</th>
                <th className={TH_NUM}>Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E5E7EB]">
              {campaigns.map((c) => {
                const f = funnelByCampaign.get(c.id)
                const h = healthByCampaign.get(c.id)
                const lastRun = (processHistory[c.id] || [])[0]
                const instantlyOk = h && !h.error && h.instantlyStatusLabel === 'active' && h.hasSendingAccounts
                const instantlyLabel = !c.instantly_campaign_id
                  ? 'not linked'
                  : h
                    ? `${h.instantlyStatusLabel}${!h.hasSendingAccounts ? ' · no accounts' : ''}`
                    : '—'
                return (
                  <tr key={c.id} className="transition hover:bg-[#F9FAFB]">
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2.5">
                        <Avatar name={c.name} size="sm" />
                        <span className="text-sm font-semibold text-[#111827]">{c.name}</span>
                      </div>
                    </td>
                    <td className="px-5 py-3">
                      <Badge tone={STATUS_TONE[c.status] || 'grey'}>{c.status}</Badge>
                    </td>
                    <td className="px-5 py-3">
                      {c.instantly_campaign_id ? (
                        <Badge tone={instantlyOk ? 'green' : 'red'}>{instantlyLabel}</Badge>
                      ) : (
                        <span className="text-xs text-[#9CA3AF]">not linked</span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-right text-sm tabular-nums text-[#6B7280]">
                      {fmt(f ? f.email.sourced.total : c.total_leads)}
                    </td>
                    <td className="px-5 py-3 text-right text-sm tabular-nums text-[#6B7280]">
                      {fmt(f?.email.emailed.total)}
                    </td>
                    <td className="px-5 py-3 text-right text-sm tabular-nums text-[#6B7280]">
                      {fmt(f?.email.replied.human)}
                    </td>
                    <td className="px-5 py-3 text-xs text-[#6B7280]">
                      {lastRun
                        ? `${formatDateTime(lastRun.created_at)} (${RUN_JOB_LABELS[lastRun.job] ?? lastRun.job})`
                        : '—'}
                    </td>
                    <td className="px-5 py-3 text-right">
                      {c.status === 'active' ? (
                        <button
                          type="button"
                          onClick={() => handleSetStatus(c, 'paused')}
                          disabled={statusUpdatingId === c.id}
                          className="rounded-full border border-[#E5E7EB] px-3 py-1 text-xs font-semibold text-[#111827] transition hover:bg-[#F3F4F6] disabled:opacity-50"
                        >
                          {statusUpdatingId === c.id ? '…' : 'Pause'}
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => handleSetStatus(c, 'active')}
                          disabled={statusUpdatingId === c.id}
                          className="rounded-full bg-[#7C3AED] px-3 py-1 text-xs font-semibold text-white transition hover:bg-[#6D28D9] disabled:opacity-50"
                        >
                          {statusUpdatingId === c.id ? '…' : 'Activate'}
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {/* ── 4. LINKEDIN strip ──────────────────────────────────────────── */}
        <div className={`${CARD} p-4`}>
          <h2 className="mb-2 text-xs font-bold uppercase tracking-wider text-[#6B7280]">LinkedIn</h2>
          {hasLinkedinActivity ? (
            <div className="flex flex-wrap gap-6">
              <FunnelStatCard label="Requested" delta={linkedinTotals.requested} />
              <FunnelStatCard label="Accepted" delta={linkedinTotals.accepted} />
              <FunnelStatCard label="Replied" delta={linkedinTotals.replied} />
            </div>
          ) : (
            <p className="text-sm text-[#9CA3AF]">No LinkedIn outreach activity yet.</p>
          )}
        </div>
      </div>
    </section>
  )
}

export default Dashboard

import { useEffect, useState } from 'react'
import api from '../api.js'
import { CARD, Badge, Avatar, SkeletonBlock, ErrorBanner, getErrorMessage } from '../ui.jsx'

// Funnel page: per-campaign conversion, one screen, scannable fast.
// Email funnel is purple, LinkedIn funnel is blue — fixed identities, always
// labeled in text so color is never the only signal.
const EMAIL_COLOR = '#7C3AED'
const LINKEDIN_COLOR = '#2563EB'
const TRACK_COLOR = '#F3F4F6'

const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString())

// Week-over-week chip: this week's count with the change vs last week.
// Null this_week means the stage has no timestamps to window (e.g. queued).
function DeltaChip({ delta }) {
  if (!delta || delta.this_week == null) {
    return <span className="text-xs text-[#9CA3AF]">— wk</span>
  }
  const diff = delta.this_week - (delta.last_week ?? 0)
  const arrow = diff > 0 ? '▲' : diff < 0 ? '▼' : '＝'
  const tone = diff > 0 ? 'text-[#047857]' : diff < 0 ? 'text-red-600' : 'text-[#6B7280]'
  return (
    <span
      className={`text-xs font-semibold ${tone}`}
      title={`${delta.this_week} in the last 7 days vs ${delta.last_week ?? 0} the 7 days before`}
    >
      {fmt(delta.this_week)} wk {arrow}
      {diff !== 0 && Math.abs(diff)}
    </span>
  )
}

// One stage cell: label, headline number, proportion bar, weekly delta and
// conversion from the previous stage.
function StageCell({ label, value, barPct, color, sub, delta, convFromPrev, live }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-[#6B7280]">
        <span className="truncate">{label}</span>
        {live && (
          <span
            className="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[#047857]"
            title="Live from Instantly"
          />
        )}
      </div>
      <p className="mt-1 font-mono text-2xl font-extrabold tabular-nums tracking-tight text-[#111827]">{fmt(value)}</p>
      {sub != null && <p className="truncate text-xs text-[#6B7280]">{sub}</p>}
      <div className="mt-2 h-1.5 w-full rounded-full" style={{ backgroundColor: TRACK_COLOR }}>
        <div
          className="h-1.5 rounded-full"
          style={{
            backgroundColor: color,
            width: `${Math.min(100, Math.max(barPct > 0 ? 2 : 0, barPct))}%`,
          }}
        />
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <DeltaChip delta={delta} />
        {convFromPrev != null && (
          <span className="text-xs text-[#9CA3AF]" title="Conversion from the previous stage (our leads)">
            {convFromPrev}%
          </span>
        )}
      </div>
    </div>
  )
}

const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null)

// Build the four email-funnel cells from one campaign's (or the totals')
// email object. Headline numbers prefer Instantly's live counts where present
// (they can exceed our DB — Instantly also sees leads added outside the app),
// so bars and conversion percentages stay on our own consistent counts.
function emailStages(email) {
  const base = email.sourced.total
  const replySub = []
  if (email.replied.human || email.replied.automated) {
    replySub.push(
      `${email.replied.human} human · ${email.replied.automated} auto · ${email.replied.actionable} actionable`
    )
  }
  const emailedLive = email.emailed.live_total != null
  const repliedLive = email.replied.live_total != null
  return [
    {
      label: 'Sourced',
      value: email.sourced.total,
      barPct: 100,
      delta: email.sourced,
    },
    {
      label: 'Emailed',
      value: emailedLive ? email.emailed.live_total : email.emailed.total,
      live: emailedLive,
      sub: emailedLive ? `ours: ${fmt(email.emailed.total)}` : null,
      barPct: pct(email.emailed.total, base) ?? 0,
      delta: email.emailed,
      convFromPrev: pct(email.emailed.total, base),
    },
    {
      label: 'Replied',
      value: repliedLive ? email.replied.live_total : email.replied.total,
      live: repliedLive,
      sub:
        replySub.join('') ||
        (repliedLive && email.replied.live_total !== email.replied.total
          ? `ours: ${fmt(email.replied.total)}`
          : null),
      barPct: pct(email.replied.total, base) ?? 0,
      delta: email.replied,
      convFromPrev: pct(email.replied.total, email.emailed.total),
    },
    {
      label: 'Meetings',
      value: email.booked.total,
      barPct: pct(email.booked.total, base) ?? 0,
      delta: email.booked,
      convFromPrev: pct(email.booked.total, email.replied.total),
    },
  ]
}

function linkedinStages(linkedin) {
  const base = linkedin.queued.total
  return [
    { label: 'Queued', value: linkedin.queued.total, barPct: 100, delta: linkedin.queued },
    {
      label: 'Requested',
      value: linkedin.requested.total,
      barPct: pct(linkedin.requested.total, base) ?? 0,
      delta: linkedin.requested,
      convFromPrev: pct(linkedin.requested.total, base),
    },
    {
      label: 'Accepted',
      value: linkedin.accepted.total,
      barPct: pct(linkedin.accepted.total, base) ?? 0,
      delta: linkedin.accepted,
      convFromPrev: pct(linkedin.accepted.total, linkedin.requested.total),
    },
    {
      label: 'Replied',
      value: linkedin.replied.total,
      barPct: pct(linkedin.replied.total, base) ?? 0,
      delta: linkedin.replied,
      convFromPrev: pct(linkedin.replied.total, linkedin.accepted.total),
    },
  ]
}

function FunnelGrid({ stages, color }) {
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
      {stages.map((s) => (
        <StageCell key={s.label} color={color} {...s} />
      ))}
    </div>
  )
}

function TrackHeading({ color, children }) {
  return (
    <div
      className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider"
      style={{ color }}
    >
      {children}
    </div>
  )
}

function CampaignFunnel({ name, status, email, linkedin, hero }) {
  return (
    <div className={`${CARD} ${hero ? 'p-6' : 'p-5'}`}>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        {!hero && <Avatar name={name} size="sm" />}
        <h3 className={`font-bold text-[#111827] ${hero ? 'text-lg' : 'text-sm'}`}>{name}</h3>
        {status && <Badge tone={status === 'active' ? 'green' : 'grey'}>{status}</Badge>}
      </div>

      <TrackHeading color={EMAIL_COLOR}>
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 6h18v12H3V6zm0 0l9 7 9-7" />
        </svg>
        Email
      </TrackHeading>
      <FunnelGrid stages={emailStages(email)} color={EMAIL_COLOR} />

      {linkedin && (
        <>
          <div className="mt-5 border-t border-[#F3F4F6] pt-4">
            <TrackHeading color={LINKEDIN_COLOR}>
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor" aria-hidden="true">
                <path d="M6.5 8.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM4.5 10h4v10h-4V10zm6.5 0h3.8v1.4h.05c.53-.95 1.83-1.95 3.77-1.95 4.03 0 4.78 2.53 4.78 5.83V20h-4v-4.3c0-1.02-.02-2.33-1.45-2.33-1.45 0-1.67 1.1-1.67 2.25V20h-4V10z" />
              </svg>
              LinkedIn
            </TrackHeading>
          </div>
          <FunnelGrid stages={linkedinStages(linkedin)} color={LINKEDIN_COLOR} />
        </>
      )}
    </div>
  )
}

function Funnel() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const res = await api.get('/funnel')
      setData(res.data)
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  // Campaigns worth a row: anything with leads, or still-active empties.
  const campaigns = (data?.campaigns || [])
    .filter((c) => c.email.sourced.total > 0 || c.status === 'active')
    .sort((a, b) => b.email.sourced.total - a.email.sourced.total)

  return (
    <section className="mx-auto max-w-6xl">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold text-[#111827]">Funnel</h1>
          <p className="mt-1 text-sm text-[#6B7280]">
            Where leads convert and where they leak. “wk” compares the last 7 days to the 7 days
            before.
            {data && !data.instantly_live && ' Instantly live stats unavailable — showing our own counts.'}
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          className="rounded-full border border-[#E5E7EB] bg-white px-4 py-1.5 text-sm font-semibold text-[#111827] transition hover:bg-[#F3F4F6]"
        >
          Refresh
        </button>
      </header>

      {loading && (
        <div className="space-y-5">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className={`${CARD} p-6`}>
              <SkeletonBlock className="mb-4 h-5 w-40" />
              <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
                {Array.from({ length: 4 }).map((__, j) => (
                  <div key={j}>
                    <SkeletonBlock className="mb-2 h-3 w-16" />
                    <SkeletonBlock className="mb-2 h-7 w-14" />
                    <SkeletonBlock className="h-1.5 w-full" />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {error && !loading && <ErrorBanner message={error} onRetry={load} />}

      {!loading && !error && data && (
        <div className="space-y-5">
          <CampaignFunnel
            hero
            name="All campaigns"
            email={data.totals.email}
            linkedin={data.totals.linkedin?.queued?.total > 0 ? data.totals.linkedin : null}
          />
          {campaigns.map((c) => (
            <CampaignFunnel
              key={c.id}
              name={c.name}
              status={c.status}
              email={c.email}
              linkedin={c.linkedin}
            />
          ))}
        </div>
      )}
    </section>
  )
}

export default Funnel

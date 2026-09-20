import { useEffect, useMemo, useState } from 'react'
import api from '../api.js'
import {
  CARD,
  TH,
  TH_NUM,
  INPUT,
  LABEL,
  Avatar,
  SkeletonTable,
  ErrorBanner,
  getErrorMessage,
} from '../ui.jsx'

// Score thresholds a rep can quickly jump to, plus "all scored leads".
const SCORE_THRESHOLDS = [
  { value: '', label: 'All scores' },
  { value: '85', label: '85+' },
  { value: '70', label: '70+' },
  { value: '50', label: '50+' },
]

function scoreTone(score) {
  if (score >= 85) return 'text-[#047857]'
  if (score >= 70) return 'text-[#7C3AED]'
  if (score >= 50) return 'text-[#B45309]'
  return 'text-[#6B7280]'
}

function CallList() {
  const [leads, setLeads] = useState([])
  const [campaigns, setCampaigns] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [campaignFilter, setCampaignFilter] = useState('all') // 'all' | id
  const [minScore, setMinScore] = useState('')

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const params = {}
      if (campaignFilter !== 'all') params.campaign_id = campaignFilter
      if (minScore !== '') params.min_score = minScore

      const [callListRes, campaignsRes] = await Promise.all([
        api.get('/call-list', { params }),
        api.get('/campaigns'),
      ])
      setLeads(callListRes.data)
      setCampaigns(campaignsRes.data)
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  // Re-fetch whenever a filter changes — filtering happens server-side so the
  // ranking/exclusions stay identical to what the backend guarantees.
  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignFilter, minScore])

  const totalCalls = leads.length
  const avgScore = useMemo(() => {
    if (!leads.length) return null
    return Math.round(leads.reduce((sum, l) => sum + (l.score ?? 0), 0) / leads.length)
  }, [leads])

  function clearFilters() {
    setCampaignFilter('all')
    setMinScore('')
  }

  return (
    <section className="mx-auto max-w-7xl">
      <header className="mb-8">
        <h1 className="text-3xl font-bold text-[#111827]">Call List</h1>
        <p className="mt-1 text-sm text-[#6B7280]">
          Highest-scoring leads, ranked for cold calling. Excludes existing customers,
          already-replied (including booked), and not-interested leads.
        </p>
      </header>

      {/* Filters */}
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label htmlFor="campaign-filter" className={LABEL}>
            Campaign
          </label>
          <select
            id="campaign-filter"
            value={campaignFilter}
            onChange={(e) => setCampaignFilter(e.target.value)}
            className={INPUT}
          >
            <option value="all">All campaigns</option>
            {campaigns.map((c) => (
              <option key={c.id} value={String(c.id)}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="score-filter" className={LABEL}>
            Score threshold
          </label>
          <select
            id="score-filter"
            value={minScore}
            onChange={(e) => setMinScore(e.target.value)}
            className={INPUT}
          >
            {SCORE_THRESHOLDS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {!loading && !error && leads.length > 0 && (
        <div className="mb-4 flex items-center gap-4 text-sm text-[#6B7280]">
          <span>
            <span className="font-semibold text-[#111827]">{totalCalls}</span> lead
            {totalCalls === 1 ? '' : 's'} to call
          </span>
          {avgScore != null && (
            <span>
              Avg score <span className="font-semibold text-[#111827]">{avgScore}</span>
            </span>
          )}
        </div>
      )}

      {loading && <SkeletonTable rows={8} cols={7} />}

      {error && !loading && <ErrorBanner message={error} onRetry={load} />}

      {!loading && !error && leads.length === 0 && (
        <div className="rounded-lg border border-dashed border-[#E5E7EB] bg-white py-16 text-center">
          <p className="text-sm text-[#6B7280]">No leads match these filters.</p>
          <button
            type="button"
            onClick={clearFilters}
            className="mt-3 text-sm font-bold text-[#7C3AED] hover:text-[#6D28D9]"
          >
            Clear filters
          </button>
        </div>
      )}

      {!loading && !error && leads.length > 0 && (
        <div className={`overflow-x-auto ${CARD}`}>
          <table className="min-w-full">
            <thead className="border-b border-[#E5E7EB]">
              <tr>
                <th className={TH_NUM}>#</th>
                <th className={TH}>Company</th>
                <th className={TH}>Contact</th>
                <th className={TH}>Title</th>
                <th className={TH_NUM}>Score</th>
                <th className={TH}>Reasoning</th>
                <th className={TH}>Location</th>
                <th className={TH}>Email</th>
                <th className={TH}>LinkedIn</th>
                <th className={TH}>Phone</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E5E7EB]">
              {leads.map((l, i) => (
                <tr key={l.id} className="transition hover:bg-[#F9FAFB]">
                  <td className="px-5 py-4 text-right text-sm tabular-nums text-[#9CA3AF]">
                    {i + 1}
                  </td>
                  <td className="px-5 py-4 text-sm font-semibold text-[#111827]">
                    <div className="flex items-center gap-2.5">
                      <Avatar name={l.company_name} size="sm" />
                      <div className="min-w-0">
                        <div className="truncate">{l.company_name}</div>
                        {l.campaign_name && (
                          <div className="truncate text-xs font-normal text-[#9CA3AF]">
                            {l.campaign_name}
                          </div>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-5 py-4 text-sm text-[#6B7280]">{l.contact_name || '—'}</td>
                  <td className="px-5 py-4 text-sm text-[#6B7280]">{l.contact_title || '—'}</td>
                  <td className="px-5 py-4 text-right text-sm tabular-nums">
                    <span className={`font-semibold ${scoreTone(l.score)}`}>{l.score}</span>
                  </td>
                  <td className="min-w-[260px] max-w-sm px-5 py-4 text-sm text-[#6B7280]">
                    <p className="line-clamp-3" title={l.reasoning || undefined}>
                      {l.reasoning || '—'}
                    </p>
                  </td>
                  <td className="px-5 py-4 text-sm text-[#6B7280]">{l.country || '—'}</td>
                  <td className="px-5 py-4 text-sm text-[#6B7280]">
                    {l.contact_email ? (
                      <a
                        href={`mailto:${l.contact_email}`}
                        className="text-[#7C3AED] hover:text-[#6D28D9] hover:underline"
                      >
                        {l.contact_email}
                      </a>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-5 py-4 text-sm">
                    {l.contact_linkedin ? (
                      <a
                        href={l.contact_linkedin}
                        target="_blank"
                        rel="noreferrer"
                        className="font-semibold text-[#0A66C2] hover:underline"
                      >
                        Profile
                      </a>
                    ) : (
                      <span className="text-[#D1D5DB]">—</span>
                    )}
                  </td>
                  <td className="px-5 py-4 text-sm">
                    <span className="text-[#D1D5DB]" title="Not yet enriched — no phone data source is configured">
                      —
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

export default CallList

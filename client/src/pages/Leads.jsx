import { Fragment, useEffect, useMemo, useState } from 'react'
import api from '../api.js'
import {
  CARD,
  TH,
  TH_NUM,
  INPUT,
  LABEL,
  BTN_PRIMARY,
  BTN_SECONDARY,
  Badge,
  Avatar,
  SkeletonBlock,
  SkeletonTable,
  ErrorBanner,
  getErrorMessage,
} from '../ui.jsx'

const LEAD_STATUS_TONE = {
  new: 'grey',
  enriched: 'blue',
  scored: 'blue',
  drafted: 'green',
  approved: 'green',
  sent: 'green',
  replied: 'green',
  booked: 'green',
  rejected: 'red',
  deprioritised: 'grey',
  bounced: 'red',
  unsubscribed: 'red',
  error: 'red',
}

// LinkedIn outreach progress (leads.linkedin_status, driven by Aimfox).
const LINKEDIN_STATUS_STYLE = {
  queued: 'text-[#9CA3AF]',
  requested: 'text-[#6B7280]',
  accepted: 'text-[#0A66C2]',
  replied: 'text-[#047857]',
}

const LINKEDIN_STATUS_ICON_PATH = {
  queued: <path d="M12 7v5l3 3M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z" />,
  requested: <path d="M5 12h13M13 6l6 6-6 6" />,
  accepted: <path d="M20 6 9 17l-5-5" />,
  replied: <path d="M4 4h16v11H8l-4 4V4z" />,
}

function LinkedinStatusIcon({ status }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-3 w-3"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {LINKEDIN_STATUS_ICON_PATH[status]}
    </svg>
  )
}

// All lead statuses, for the status filter dropdown.
const STATUS_OPTIONS = Object.keys(LEAD_STATUS_TONE)

// The forward pipeline shown in the summary bar. Each milestone rolls up the
// intermediate lifecycle statuses that sit at that stage, so every in-flight
// lead lands in exactly one stage (terminal statuses like rejected/bounced are
// not part of the forward pipeline and aren't counted here).
const PIPELINE_STAGES = [
  { key: 'new', label: 'New', statuses: ['new', 'enriched'] },
  { key: 'scored', label: 'Scored', statuses: ['scored'] },
  { key: 'drafted', label: 'Drafted', statuses: ['drafted', 'approved'] },
  { key: 'sent', label: 'Sent', statuses: ['sent'] },
  { key: 'replied', label: 'Replied', statuses: ['replied'] },
  { key: 'booked', label: 'Booked', statuses: ['booked'] },
]

// status -> stage key, for tallying each lead into its pipeline stage.
const STATUS_TO_STAGE = Object.fromEntries(
  PIPELINE_STAGES.flatMap((stage) => stage.statuses.map((s) => [s, stage.key]))
)

// Leads in these statuses have already been through the pipeline — the action
// re-runs it (grey "Reprocess") rather than running it for the first time.
const REPROCESSED_STATUSES = new Set([
  'drafted',
  'approved',
  'sent',
  'replied',
  'booked',
  'deprioritised',
  'error',
])

const PAGE_SIZE = 25

// Format an ISO timestamp as DD/MM/YYYY, or '—' if missing/invalid.
function formatDate(value) {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  const day = String(d.getDate()).padStart(2, '0')
  const month = String(d.getMonth() + 1).padStart(2, '0')
  return `${day}/${month}/${d.getFullYear()}`
}

// Sort by score, pushing leads without a score to the end in both directions.
function compareScore(a, b, dir) {
  const aNull = a.score == null
  const bNull = b.score == null
  if (aNull && bNull) return 0
  if (aNull) return 1
  if (bNull) return -1
  return dir === 'desc' ? b.score - a.score : a.score - b.score
}

// Sort by created_at, pushing leads without a date to the end in both directions.
function compareDate(a, b, dir) {
  const aTime = a.created_at ? new Date(a.created_at).getTime() : NaN
  const bTime = b.created_at ? new Date(b.created_at).getTime() : NaN
  const aNull = Number.isNaN(aTime)
  const bNull = Number.isNaN(bTime)
  if (aNull && bNull) return 0
  if (aNull) return 1
  if (bNull) return -1
  return dir === 'desc' ? bTime - aTime : aTime - bTime
}

const EMPTY_FORM = {
  company_name: '',
  contact_name: '',
  contact_title: '',
  contact_email: '',
  industry: '',
  fleet_size: '',
  country: '',
}

function Leads() {
  const [leads, setLeads] = useState([])
  const [campaigns, setCampaigns] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [processingId, setProcessingId] = useState(null)
  const [rowError, setRowError] = useState(null)

  // Filters / sort / pagination.
  const [campaignFilter, setCampaignFilter] = useState('all') // 'all' | 'none' | id
  const [statusFilter, setStatusFilter] = useState('all')
  const [stageFilter, setStageFilter] = useState(null) // pipeline stage key or null
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState('score') // 'score' | 'date'
  const [sortDir, setSortDir] = useState('desc') // sort direction
  const [page, setPage] = useState(0)

  const [showModal, setShowModal] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      // Campaigns power the campaign filter; leads are the table data.
      const [leadsRes, campaignsRes] = await Promise.all([
        api.get('/leads'),
        api.get('/campaigns'),
      ])
      setLeads(leadsRes.data)
      setCampaigns(campaignsRes.data)
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  // Leads in the current campaign + search context, before the status/stage
  // filter. This is what the pipeline summary bar counts over, so the bar
  // reflects the distribution within whatever the user is currently viewing.
  const scopedLeads = useMemo(() => {
    const term = search.trim().toLowerCase()
    return leads.filter((l) => {
      if (campaignFilter === 'none' && l.campaign_id != null) return false
      if (
        campaignFilter !== 'all' &&
        campaignFilter !== 'none' &&
        String(l.campaign_id) !== campaignFilter
      ) {
        return false
      }
      if (term && !(l.company_name || '').toLowerCase().includes(term)) return false
      return true
    })
  }, [leads, campaignFilter, search])

  // Count of leads at each pipeline stage, within the current scope.
  const stageCounts = useMemo(() => {
    const counts = Object.fromEntries(PIPELINE_STAGES.map((s) => [s.key, 0]))
    for (const l of scopedLeads) {
      const stage = STATUS_TO_STAGE[l.status]
      if (stage) counts[stage] += 1
    }
    return counts
  }, [scopedLeads])

  // Apply the status dropdown / pipeline-stage filter, then sort. Pagination
  // slices the sorted result below.
  const sorted = useMemo(() => {
    const stageStatuses = stageFilter
      ? PIPELINE_STAGES.find((s) => s.key === stageFilter)?.statuses
      : null
    const filtered = scopedLeads.filter((l) => {
      if (stageStatuses) return stageStatuses.includes(l.status)
      if (statusFilter !== 'all' && l.status !== statusFilter) return false
      return true
    })
    const compare = sortBy === 'date' ? compareDate : compareScore
    return [...filtered].sort((a, b) => compare(a, b, sortDir))
  }, [scopedLeads, statusFilter, stageFilter, sortBy, sortDir])

  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE))

  // Reset to the first page whenever the filters change the result set.
  useEffect(() => {
    setPage(0)
  }, [campaignFilter, statusFilter, stageFilter, search, sortBy, sortDir])

  // Keep the page in range if the result set shrinks.
  useEffect(() => {
    if (page > pageCount - 1) setPage(pageCount - 1)
  }, [page, pageCount])

  const pageStart = page * PAGE_SIZE
  const pageLeads = sorted.slice(pageStart, pageStart + PAGE_SIZE)
  const rangeStart = sorted.length === 0 ? 0 : pageStart + 1
  const rangeEnd = Math.min(pageStart + PAGE_SIZE, sorted.length)

  useEffect(() => {
    if (!showModal) return undefined
    function onKey(e) {
      if (e.key === 'Escape') closeModal()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showModal])

  async function processLead(id) {
    setProcessingId(id)
    setRowError(null)
    try {
      const { data } = await api.post(`/leads/${id}/process`)
      // Reflect the new status/score on the row without a full refetch.
      setLeads((prev) =>
        prev.map((l) =>
          l.id === id
            ? {
                ...l,
                status: data.status ?? l.status,
                score: data.score ?? l.score,
              }
            : l
        )
      )
    } catch (err) {
      setRowError(getErrorMessage(err))
    } finally {
      setProcessingId(null)
    }
  }

  function updateField(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  function openModal() {
    setForm(EMPTY_FORM)
    setSubmitError(null)
    setShowModal(true)
  }

  function closeModal() {
    if (submitting) return
    setShowModal(false)
    setSubmitError(null)
  }

  async function handleSubmit(event) {
    event.preventDefault()
    if (!form.company_name.trim()) {
      setSubmitError('Company name is required.')
      return
    }

    setSubmitting(true)
    setSubmitError(null)

    const payload = {}
    for (const [key, value] of Object.entries(form)) {
      if (value !== '') payload[key] = value
    }
    if (payload.fleet_size !== undefined) {
      payload.fleet_size = Number(payload.fleet_size)
    }

    try {
      await api.post('/leads', payload)
      setShowModal(false)
      await load()
    } catch (err) {
      setSubmitError(getErrorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  // The pipeline bar and the status dropdown are two ways to filter by status —
  // keep them mutually exclusive so the active filter is never ambiguous.
  function selectStage(key) {
    setStatusFilter('all')
    setStageFilter((prev) => (prev === key ? null : key))
  }

  function selectStatus(value) {
    setStageFilter(null)
    setStatusFilter(value)
  }

  // Toggle the sort column / direction. Clicking the active column flips the
  // direction; clicking a new column switches to it, starting descending.
  function toggleSort(key) {
    if (sortBy === key) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))
    } else {
      setSortBy(key)
      setSortDir('desc')
    }
  }

  function clearFilters() {
    setSearch('')
    setCampaignFilter('all')
    setStatusFilter('all')
    setStageFilter(null)
  }

  const totalInPipeline = PIPELINE_STAGES.reduce((acc, s) => acc + stageCounts[s.key], 0)

  return (
    <section className="mx-auto max-w-7xl">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-[#111827]">Leads</h1>
          <p className="mt-1 text-sm text-[#6B7280]">
            Browse leads and run the scoring &amp; drafting pipeline.
          </p>
        </div>
        <button type="button" onClick={openModal} className={BTN_PRIMARY}>
          <span className="text-base leading-none">+</span>
          Add Lead
        </button>
      </header>

      {rowError && (
        <div className="mb-4">
          <ErrorBanner message={rowError} />
        </div>
      )}

      {loading && (
        <div className="space-y-6">
          <div className={`${CARD} p-4`}>
            <SkeletonBlock className="mb-3 h-3 w-20" />
            <div className="flex items-stretch gap-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <SkeletonBlock key={i} className="h-16 flex-1" />
              ))}
            </div>
          </div>
          <SkeletonTable rows={8} cols={6} />
        </div>
      )}

      {error && !loading && <ErrorBanner message={error} onRetry={load} />}

      {!loading && !error && leads.length === 0 && (
        <div className="rounded-lg border border-dashed border-[#E5E7EB] bg-white py-16 text-center">
          <p className="text-sm text-[#6B7280]">No leads yet.</p>
          <button
            type="button"
            onClick={openModal}
            className="mt-3 text-sm font-bold text-[#7C3AED] hover:text-[#6D28D9]"
          >
            Add your first lead
          </button>
        </div>
      )}

      {!loading && !error && leads.length > 0 && (
        <>
          {/* Pipeline summary bar — counts per stage, click to filter */}
          <div className={`mb-6 ${CARD} p-4`}>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-[#9CA3AF]">
                Pipeline
              </h2>
              <div className="flex items-center gap-3 text-xs">
                <span className="text-[#9CA3AF]">
                  <span className="font-semibold text-[#6B7280]">{totalInPipeline}</span> in
                  flight
                </span>
                {stageFilter && (
                  <button
                    type="button"
                    onClick={() => setStageFilter(null)}
                    className="font-semibold text-[#7C3AED] hover:text-[#6D28D9]"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>
            <div className="flex items-stretch gap-2 overflow-x-auto">
              {PIPELINE_STAGES.map((stage, i) => (
                <Fragment key={stage.key}>
                  <button
                    type="button"
                    onClick={() => selectStage(stage.key)}
                    aria-pressed={stageFilter === stage.key}
                    title={`Show ${stage.label} leads`}
                    className={`flex min-w-[88px] flex-1 flex-col items-center rounded-lg border px-3 py-3 transition ${
                      stageFilter === stage.key
                        ? 'border-[#7C3AED] bg-[#7C3AED]/10'
                        : 'border-[#E5E7EB] bg-[#F8F9FA] hover:border-[#7C3AED]/40'
                    }`}
                  >
                    <span className="text-2xl font-extrabold tabular-nums text-[#111827]">
                      {stageCounts[stage.key]}
                    </span>
                    <span className="mt-1 text-xs font-semibold uppercase tracking-wider text-[#6B7280]">
                      {stage.label}
                    </span>
                  </button>
                  {i < PIPELINE_STAGES.length - 1 && (
                    <div
                      className="flex shrink-0 items-center text-lg text-[#9CA3AF]"
                      aria-hidden="true"
                    >
                      →
                    </div>
                  )}
                </Fragment>
              ))}
            </div>
          </div>

          {/* Filters */}
          <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="lg:col-span-2">
              <label htmlFor="search" className={LABEL}>
                Search company
              </label>
              <input
                id="search"
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by company name…"
                className={INPUT}
              />
            </div>
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
                <option value="none">Unassigned</option>
                {campaigns.map((c) => (
                  <option key={c.id} value={String(c.id)}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="status-filter" className={LABEL}>
                Status
              </label>
              <select
                id="status-filter"
                value={statusFilter}
                onChange={(e) => selectStatus(e.target.value)}
                className={INPUT}
              >
                <option value="all">All statuses</option>
                {STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {sorted.length === 0 ? (
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
          ) : (
            <>
              <div className={`overflow-x-auto ${CARD}`}>
                <table className="min-w-full">
                  <thead className="border-b border-[#E5E7EB]">
                    <tr>
                      <th className={TH}>Company</th>
                      <th className={TH}>Contact</th>
                      <th className={TH}>Title</th>
                      <th className={TH}>Industry</th>
                      <th className={TH_NUM}>Fleet</th>
                      <th className={TH}>Country</th>
                      <th className={TH}>
                        <button
                          type="button"
                          onClick={() => toggleSort('date')}
                          className="flex items-center gap-1 uppercase tracking-wider text-[#9CA3AF] transition hover:text-[#6B7280]"
                        >
                          Added
                          {sortBy === 'date' && (
                            <span aria-hidden="true">{sortDir === 'desc' ? '▼' : '▲'}</span>
                          )}
                        </button>
                      </th>
                      <th className={TH_NUM}>
                        <button
                          type="button"
                          onClick={() => toggleSort('score')}
                          className="ml-auto flex items-center gap-1 uppercase tracking-wider text-[#9CA3AF] transition hover:text-[#6B7280]"
                        >
                          Score
                          {sortBy === 'score' && (
                            <span aria-hidden="true">{sortDir === 'desc' ? '▼' : '▲'}</span>
                          )}
                        </button>
                      </th>
                      <th className={TH}>Status</th>
                      <th className={TH}>LinkedIn</th>
                      <th className={`${TH} text-right`}>Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#E5E7EB]">
                    {pageLeads.map((l) => (
                      <tr key={l.id} className="transition hover:bg-[#F9FAFB]">
                        <td className="px-5 py-4 text-sm font-semibold text-[#111827]">
                          <div className="flex items-center gap-2.5">
                            <Avatar name={l.company_name} size="sm" />
                            <span>{l.company_name}</span>
                          </div>
                        </td>
                        <td className="px-5 py-4 text-sm text-[#6B7280]">
                          {l.contact_name || '—'}
                        </td>
                        <td className="px-5 py-4 text-sm text-[#6B7280]">
                          {l.contact_title || '—'}
                        </td>
                        <td className="px-5 py-4 text-sm text-[#6B7280]">
                          {l.industry || '—'}
                        </td>
                        <td className="px-5 py-4 text-right text-sm tabular-nums text-[#6B7280]">
                          {l.fleet_size ?? '—'}
                        </td>
                        <td className="px-5 py-4 text-sm text-[#6B7280]">
                          {l.country || '—'}
                        </td>
                        <td className="px-5 py-4 text-sm tabular-nums text-[#6B7280]">
                          {formatDate(l.created_at)}
                        </td>
                        <td className="px-5 py-4 text-right text-sm tabular-nums">
                          {l.score == null ? (
                            <span className="text-[#9CA3AF]">—</span>
                          ) : (
                            <span
                              className={
                                l.score >= 50
                                  ? 'font-semibold text-[#7C3AED]'
                                  : 'text-[#6B7280]'
                              }
                            >
                              {l.score}
                            </span>
                          )}
                        </td>
                        <td className="px-5 py-4 text-sm">
                          <Badge tone={LEAD_STATUS_TONE[l.status] || 'grey'}>
                            {l.status}
                          </Badge>
                        </td>
                        <td className="px-5 py-4 text-sm">
                          {l.linkedin_status ? (
                            <span
                              title={`LinkedIn: ${l.linkedin_status}`}
                              className={`inline-flex items-center gap-1.5 text-xs font-semibold ${
                                LINKEDIN_STATUS_STYLE[l.linkedin_status] ?? 'text-[#9CA3AF]'
                              }`}
                            >
                              <LinkedinStatusIcon status={l.linkedin_status} />
                              {l.linkedin_status}
                            </span>
                          ) : (
                            <span className="text-[#D1D5DB]">—</span>
                          )}
                        </td>
                        <td className="px-5 py-4 text-right">
                          {(() => {
                            const reprocessed = REPROCESSED_STATUSES.has(l.status)
                            const label = processingId === l.id
                              ? 'Processing…'
                              : reprocessed
                                ? 'Reprocess'
                                : 'Process'
                            return (
                              <button
                                type="button"
                                onClick={() => processLead(l.id)}
                                disabled={processingId === l.id}
                                className={`${reprocessed ? BTN_SECONDARY : BTN_PRIMARY} px-4 py-1.5`}
                              >
                                {label}
                              </button>
                            )
                          })()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-[#6B7280]">
                <span>
                  Showing <span className="text-[#111827]">{rangeStart}</span>–
                  <span className="text-[#111827]">{rangeEnd}</span> of{' '}
                  <span className="text-[#111827]">{sorted.length}</span>
                </span>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    disabled={page <= 0}
                    className={`${BTN_SECONDARY} px-4 py-1.5`}
                  >
                    Previous
                  </button>
                  <span>
                    Page {page + 1} of {pageCount}
                  </span>
                  <button
                    type="button"
                    onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                    disabled={page >= pageCount - 1}
                    className={`${BTN_SECONDARY} px-4 py-1.5`}
                  >
                    Next
                  </button>
                </div>
              </div>
            </>
          )}
        </>
      )}

      {showModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onMouseDown={closeModal}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-lead-title"
            className="w-full max-w-lg rounded-xl bg-white shadow-2xl"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-[#E5E7EB] px-6 py-4">
              <h2 id="add-lead-title" className="text-lg font-bold text-[#111827]">
                Add lead
              </h2>
              <button
                type="button"
                onClick={closeModal}
                aria-label="Close"
                className="rounded-md p-1 text-[#6B7280] transition hover:bg-[#F3F4F6] hover:text-[#111827]"
              >
                <span className="text-xl leading-none">×</span>
              </button>
            </div>

            <form onSubmit={handleSubmit} className="px-6 py-5">
              <div className="space-y-4">
                <div>
                  <label htmlFor="company_name" className={LABEL}>
                    Company name
                  </label>
                  <input
                    id="company_name"
                    type="text"
                    value={form.company_name}
                    onChange={(e) => updateField('company_name', e.target.value)}
                    placeholder="e.g. Virgin Media"
                    className={INPUT}
                    required
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="contact_name" className={LABEL}>
                      Contact name
                    </label>
                    <input
                      id="contact_name"
                      type="text"
                      value={form.contact_name}
                      onChange={(e) => updateField('contact_name', e.target.value)}
                      className={INPUT}
                    />
                  </div>
                  <div>
                    <label htmlFor="contact_title" className={LABEL}>
                      Contact title
                    </label>
                    <input
                      id="contact_title"
                      type="text"
                      value={form.contact_title}
                      onChange={(e) => updateField('contact_title', e.target.value)}
                      className={INPUT}
                    />
                  </div>
                </div>

                <div>
                  <label htmlFor="contact_email" className={LABEL}>
                    Contact email
                  </label>
                  <input
                    id="contact_email"
                    type="email"
                    value={form.contact_email}
                    onChange={(e) => updateField('contact_email', e.target.value)}
                    className={INPUT}
                  />
                </div>

                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <label htmlFor="industry" className={LABEL}>
                      Industry
                    </label>
                    <input
                      id="industry"
                      type="text"
                      value={form.industry}
                      onChange={(e) => updateField('industry', e.target.value)}
                      className={INPUT}
                    />
                  </div>
                  <div>
                    <label htmlFor="fleet_size" className={LABEL}>
                      Fleet size
                    </label>
                    <input
                      id="fleet_size"
                      type="number"
                      min="0"
                      value={form.fleet_size}
                      onChange={(e) => updateField('fleet_size', e.target.value)}
                      className={INPUT}
                    />
                  </div>
                  <div>
                    <label htmlFor="country" className={LABEL}>
                      Country
                    </label>
                    <input
                      id="country"
                      type="text"
                      value={form.country}
                      onChange={(e) => updateField('country', e.target.value)}
                      className={INPUT}
                    />
                  </div>
                </div>
              </div>

              {submitError && (
                <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                  {submitError}
                </p>
              )}

              <div className="mt-6 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={closeModal}
                  disabled={submitting}
                  className={BTN_SECONDARY}
                >
                  Cancel
                </button>
                <button type="submit" disabled={submitting} className={BTN_PRIMARY}>
                  {submitting ? 'Adding…' : 'Add lead'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </section>
  )
}

export default Leads

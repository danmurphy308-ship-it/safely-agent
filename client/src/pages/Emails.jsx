import { Fragment, useEffect, useMemo, useState } from 'react'
import api from '../api.js'
import {
  CARD,
  TH,
  INPUT,
  Badge,
  Avatar,
  SkeletonTable,
  ErrorBanner,
  getErrorMessage,
} from '../ui.jsx'

// Map a row to its outreach status badge. Prefer the lead's lifecycle status
// (replied/booked) over the raw send timestamp.
function outreachStatus(e) {
  const s = e.lead_status
  if (s === 'booked') return { label: 'booked', tone: 'purple' }
  if (s === 'replied') return { label: 'replied', tone: 'blue' }
  if (e.sent_at || s === 'sent') return { label: 'sent', tone: 'green' }
  return { label: s || 'pending', tone: 'grey' }
}

function formatDate(value) {
  if (!value) return '—'
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString()
}

function Emails() {
  const [emails, setEmails] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [campaigns, setCampaigns] = useState([])
  const [campaignFilter, setCampaignFilter] = useState('all') // campaign id or 'all'
  const [search, setSearch] = useState('')
  const [expandedId, setExpandedId] = useState(null)

  // "Delete drafts whose lead has no email" cleanup.
  const [showCleanup, setShowCleanup] = useState(false)
  const [cleaningUp, setCleaningUp] = useState(false)
  const [cleanupError, setCleanupError] = useState(null)
  const [cleanupResult, setCleanupResult] = useState(null) // count deleted, or null

  function toggleExpand(id) {
    setExpandedId((prev) => (prev === id ? null : id))
  }

  // Download the "ready to send" CSV. The route sets a Content-Disposition
  // attachment header, so pointing a temporary <a> at it triggers a download.
  function exportEmails() {
    const base = api.defaults.baseURL || '/api'
    const link = document.createElement('a')
    link.href = `${base}/emails/export`
    link.download = 'emails-ready-to-send.csv'
    document.body.appendChild(link)
    link.click()
    link.remove()
  }

  async function load(campaign = campaignFilter) {
    setLoading(true)
    setError(null)
    try {
      const params = {}
      if (campaign !== 'all') params.campaign_id = campaign
      const { data } = await api.get('/emails', { params })
      setEmails(data)
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load(campaignFilter)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignFilter])

  // Load campaigns once for the filter dropdown. A failure just leaves the
  // dropdown with only "All campaigns" — it shouldn't break the page.
  useEffect(() => {
    api
      .get('/campaigns')
      .then(({ data }) => setCampaigns(data))
      .catch(() => {})
  }, [])

  // Client-side search over company or contact name.
  const visibleEmails = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return emails
    return emails.filter(
      (e) =>
        (e.lead_company_name || '').toLowerCase().includes(term) ||
        (e.lead_contact_name || '').toLowerCase().includes(term)
    )
  }, [emails, search])

  function closeCleanup() {
    if (cleaningUp) return
    setShowCleanup(false)
    setCleanupError(null)
  }

  async function confirmCleanup() {
    setCleaningUp(true)
    setCleanupError(null)
    try {
      const { data } = await api.delete('/emails/no-contact-email')
      setCleanupResult(data.deleted)
      setShowCleanup(false)
      // Some listed rows may have been deleted — refresh.
      await load(campaignFilter)
    } catch (err) {
      setCleanupError(getErrorMessage(err))
    } finally {
      setCleaningUp(false)
    }
  }

  return (
    <section className="mx-auto max-w-7xl">
      <header className="mb-6">
        <h1 className="text-3xl font-bold text-[#111827]">Outreach</h1>
        <p className="mt-1 text-sm text-[#6B7280]">
          Every email that's gone out, with its current status. Search by company
          or contact.
        </p>
      </header>

      {/* Toolbar: search + campaign dropdown + actions */}
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <div className="relative min-w-[240px] flex-1 sm:max-w-sm">
          <input
            type="text"
            value={search}
            onChange={(ev) => setSearch(ev.target.value)}
            placeholder="Search company or contact…"
            className={INPUT}
          />
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-[#6B7280]">
            <span className="text-xs font-semibold uppercase tracking-wider text-[#6B7280]">
              Campaign
            </span>
            <select
              value={campaignFilter}
              onChange={(ev) => setCampaignFilter(ev.target.value)}
              className="rounded-full border border-[#E5E7EB] bg-white px-4 py-1.5 text-sm font-semibold text-[#111827] transition focus:border-[#7C3AED] focus:outline-none focus:ring-2 focus:ring-[#7C3AED]/30"
            >
              <option value="all">All campaigns</option>
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={exportEmails}
            title="Download ready-to-send emails as CSV"
            className="inline-flex items-center gap-1.5 rounded-full border border-[#E5E7EB] bg-white px-3 py-1.5 text-xs font-semibold text-[#6B7280] transition hover:bg-[#F3F4F6] hover:text-[#111827]"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              className="h-3.5 w-3.5"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <path d="M7 10l5 5 5-5" />
              <path d="M12 15V3" />
            </svg>
            Export
          </button>
          <button
            type="button"
            onClick={() => {
              setCleanupError(null)
              setShowCleanup(true)
            }}
            title="Delete drafts whose lead has no email address"
            className="inline-flex items-center gap-1.5 rounded-full border border-red-200 bg-white px-3 py-1.5 text-xs font-semibold text-red-600 transition hover:border-red-300 hover:bg-red-50"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              className="h-3.5 w-3.5"
            >
              <path d="M3 6h18" />
              <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
            </svg>
            Delete no-email drafts
          </button>
        </div>
      </div>

      {cleanupResult !== null && (
        <div className="mb-4 flex items-center justify-between gap-4 rounded-xl border border-[#7C3AED]/20 bg-[#F5F3FF] px-4 py-3 text-sm text-[#6B7280]">
          <div>
            Deleted{' '}
            <span className="font-semibold text-[#111827]">{cleanupResult}</span> draft
            {cleanupResult === 1 ? '' : 's'} whose lead had no email address.
          </div>
          <button
            type="button"
            onClick={() => setCleanupResult(null)}
            aria-label="Dismiss"
            className="rounded-md p-1 text-[#6B7280] transition hover:bg-black/5 hover:text-[#111827]"
          >
            <span className="text-lg leading-none">×</span>
          </button>
        </div>
      )}

      {loading && <SkeletonTable rows={6} cols={5} />}

      {error && !loading && <ErrorBanner message={error} onRetry={() => load(campaignFilter)} />}

      {!loading && !error && visibleEmails.length === 0 && (
        <div className="rounded-xl border border-dashed border-[#E5E7EB] bg-white py-16 text-center">
          <p className="text-sm text-[#6B7280]">
            {search.trim() ? 'No emails match your search.' : 'No outreach yet.'}
          </p>
        </div>
      )}

      {!loading && !error && visibleEmails.length > 0 && (
        <div className={`overflow-x-auto ${CARD}`}>
          <table className="min-w-full">
            <thead className="border-b border-[#E5E7EB]">
              <tr>
                <th className={TH}>Contact</th>
                <th className={TH}>Company</th>
                <th className={TH}>Subject</th>
                <th className={TH}>Sent date</th>
                <th className={TH}>Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E5E7EB]">
              {visibleEmails.map((e) => {
                const status = outreachStatus(e)
                return (
                  <Fragment key={e.id}>
                    <tr
                      onClick={() => toggleExpand(e.id)}
                      aria-expanded={expandedId === e.id}
                      className="cursor-pointer transition hover:bg-[#F9FAFB]"
                    >
                      <td className="px-5 py-4 text-sm font-semibold text-[#111827]">
                        <div className="flex items-center gap-2">
                          <span
                            aria-hidden="true"
                            className={`text-[10px] text-[#9CA3AF] transition-transform ${
                              expandedId === e.id ? 'rotate-90' : ''
                            }`}
                          >
                            ▶
                          </span>
                          <Avatar name={e.lead_company_name || e.lead_contact_name || '?'} size="sm" />
                          {e.lead_contact_name || '—'}
                        </div>
                      </td>
                      <td className="px-5 py-4 text-sm text-[#6B7280]">
                        {e.lead_company_name || '—'}
                      </td>
                      <td className="px-5 py-4 text-sm text-[#6B7280]">
                        <span className="block max-w-[260px] truncate">
                          {e.subject || '—'}
                        </span>
                      </td>
                      <td className="px-5 py-4 text-sm text-[#6B7280] whitespace-nowrap">
                        {formatDate(e.sent_at)}
                      </td>
                      <td className="px-5 py-4 text-sm">
                        <Badge tone={status.tone}>{status.label}</Badge>
                      </td>
                    </tr>

                    {expandedId === e.id && (
                      <tr className="bg-[#F9FAFB]">
                        <td colSpan={5} className="px-5 pb-5 pt-0">
                          <div className="rounded-lg border border-[#E5E7EB] bg-white p-4">
                            <div className="mb-4 grid grid-cols-2 gap-4">
                              <div>
                                <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-[#6B7280]">
                                  Contact
                                </div>
                                <div className="text-sm text-[#111827]">
                                  {e.lead_contact_name || '—'}
                                </div>
                              </div>
                              <div>
                                <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-[#6B7280]">
                                  Email
                                </div>
                                <div className="text-sm text-[#111827]">
                                  {e.lead_contact_email || '—'}
                                </div>
                              </div>
                            </div>
                            <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-[#6B7280]">
                              Subject
                            </div>
                            <div className="mb-4 text-sm font-semibold text-[#111827]">
                              {e.subject || '—'}
                            </div>
                            <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-[#6B7280]">
                              Body
                            </div>
                            <div className="whitespace-pre-wrap text-sm leading-relaxed text-[#6B7280]">
                              {e.body || '—'}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Cleanup confirmation dialog */}
      {showCleanup && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onMouseDown={closeCleanup}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="cleanup-title"
            className="w-full max-w-md rounded-xl bg-white shadow-2xl"
            onMouseDown={(ev) => ev.stopPropagation()}
          >
            <div className="border-b border-[#E5E7EB] px-6 py-4">
              <h2 id="cleanup-title" className="text-lg font-bold text-[#111827]">
                Delete drafts with no email
              </h2>
            </div>

            <div className="px-6 py-5">
              <p className="text-sm text-[#6B7280]">
                Permanently delete every email whose lead has no contact email
                address? These can never be sent. This cannot be undone.
              </p>

              {cleanupError && (
                <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                  {cleanupError}
                </p>
              )}

              <div className="mt-6 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={closeCleanup}
                  disabled={cleaningUp}
                  className="rounded-full border border-[#E5E7EB] bg-white px-6 py-2.5 text-sm font-bold text-[#111827] transition hover:bg-[#F3F4F6] disabled:opacity-60"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={confirmCleanup}
                  disabled={cleaningUp}
                  className="inline-flex items-center rounded-full bg-red-500 px-6 py-2.5 text-sm font-bold text-white transition hover:bg-red-600 focus:outline-none focus:ring-2 focus:ring-red-500/50 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {cleaningUp ? 'Deleting…' : 'Delete drafts'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

export default Emails

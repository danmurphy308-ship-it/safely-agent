import { Fragment, useEffect, useState } from 'react'
import api from '../api.js'
import {
  CARD,
  TH,
  BTN_PRIMARY,
  BTN_SECONDARY,
  Badge,
  CATEGORY_BADGE,
  Avatar,
  SkeletonTable,
  ErrorBanner,
  getErrorMessage,
} from '../ui.jsx'

// Format an Instantly reply timestamp for display; leave junk values blank.
function formatTimestamp(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString()
}

// Copy-to-clipboard button with a brief "Copied" confirmation.
function CopyButton({ text }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={async (ev) => {
        ev.stopPropagation()
        try {
          await navigator.clipboard.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 1600)
        } catch {
          /* clipboard unavailable — nothing to do */
        }
      }}
      className={`${BTN_SECONDARY} px-3 py-1 text-xs`}
    >
      {copied ? '✓ Copied' : 'Copy'}
    </button>
  )
}

// Suggested draft in an expandable box: category-colored, copyable, never
// auto-sent — the human pastes it into Instantly / LinkedIn themselves.
function DraftBox({ title, text }) {
  return (
    <div className="mt-4 rounded-md border border-[#7C3AED]/30 bg-[#F5F3FF] p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-xs font-semibold uppercase tracking-wider text-[#6D28D9]">
          {title}
        </div>
        <CopyButton text={text} />
      </div>
      <div className="whitespace-pre-wrap text-sm leading-relaxed text-[#111827]">{text}</div>
    </div>
  )
}

// Replies pulled from Instantly for the configured campaign, enriched with the
// matching lead's company. Expand a row to read the reply; book the meeting
// (→ booked) or mark not interested (→ rejected) when we matched a lead.
function Replies() {
  const [replies, setReplies] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [actingKey, setActingKey] = useState(null)
  const [rowError, setRowError] = useState(null)
  const [expandedKey, setExpandedKey] = useState(null)

  // Rows have no guaranteed Instantly id, so fall back to the list index.
  const rowKey = (r, i) => r.id ?? `idx-${i}`

  function toggleExpand(key) {
    setExpandedKey((prev) => (prev === key ? null : key))
  }

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const { data } = await api.get('/replies')
      setReplies(data)
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  // Mark the lead booked or not-interested, then drop every reply from that lead
  // — it's no longer awaiting a triage decision.
  async function act(reply, key, endpoint) {
    if (!reply.lead_id) return
    setActingKey(key)
    setRowError(null)
    try {
      await api.post(`/leads/${reply.lead_id}/${endpoint}`)
      setReplies((prev) => prev.filter((r) => r.lead_id !== reply.lead_id))
    } catch (err) {
      setRowError(getErrorMessage(err))
    } finally {
      setActingKey(null)
    }
  }

  return (
    <section className="mx-auto max-w-7xl">
      <header className="mb-8">
        <h1 className="text-3xl font-bold text-[#111827]">Replies</h1>
        <p className="mt-1 text-sm text-[#6B7280]">
          Replies to outreach, pulled from Instantly. Expand to read; book the
          meeting or mark not interested.
        </p>
      </header>

      {rowError && (
        <div className="mb-4">
          <ErrorBanner message={rowError} />
        </div>
      )}

      {loading && <SkeletonTable rows={6} cols={6} />}

      {error && !loading && <ErrorBanner message={error} onRetry={load} />}

      {!loading && !error && replies.length === 0 && (
        <div className="rounded-lg border border-dashed border-[#E5E7EB] bg-white py-16 text-center">
          <p className="text-sm text-[#6B7280]">No replies yet.</p>
        </div>
      )}

      {!loading && !error && replies.length > 0 && (
        <div className={`overflow-x-auto ${CARD}`}>
          <table className="min-w-full">
            <thead className="border-b border-[#E5E7EB]">
              <tr>
                <th className={TH}>Company</th>
                <th className={TH}>Email</th>
                <th className={TH}>Category</th>
                <th className={TH}>Subject</th>
                <th className={TH}>Received</th>
                <th className={`${TH} text-right`}>Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E5E7EB]">
              {replies.map((r, i) => {
                const key = rowKey(r, i)
                return (
                  <Fragment key={key}>
                    <tr
                      onClick={() => toggleExpand(key)}
                      aria-expanded={expandedKey === key}
                      className="cursor-pointer transition hover:bg-[#F9FAFB]"
                    >
                      <td className="px-5 py-4 text-sm font-semibold text-[#111827]">
                        <div className="flex items-center gap-2">
                          <span
                            aria-hidden="true"
                            className={`text-[10px] text-[#9CA3AF] transition-transform ${
                              expandedKey === key ? 'rotate-90' : ''
                            }`}
                          >
                            ▶
                          </span>
                          <Avatar name={r.company_name || r.contact_email || '?'} size="sm" />
                          {r.company_name || '—'}
                        </div>
                      </td>
                      <td className="px-5 py-4 text-sm text-[#6B7280]">
                        <span className="block max-w-[200px] truncate">
                          {r.contact_email || '—'}
                        </span>
                      </td>
                      <td className="px-5 py-4">
                        {r.category ? (
                          <Badge tone={CATEGORY_BADGE[r.category]?.tone || 'grey'}>
                            {CATEGORY_BADGE[r.category]?.label || r.category}
                          </Badge>
                        ) : (
                          <span className="text-sm text-[#9CA3AF]">—</span>
                        )}
                      </td>
                      <td className="px-5 py-4 text-sm text-[#6B7280]">
                        <span className="block max-w-[260px] truncate">
                          {r.subject || '—'}
                        </span>
                      </td>
                      <td className="px-5 py-4 text-sm text-[#6B7280] whitespace-nowrap">
                        {formatTimestamp(r.timestamp)}
                      </td>
                      <td className="px-5 py-4">
                        <div className="flex justify-end gap-2 whitespace-nowrap">
                          <button
                            type="button"
                            onClick={(ev) => {
                              ev.stopPropagation()
                              act(r, key, 'mark-booked')
                            }}
                            disabled={actingKey === key || !r.lead_id}
                            title={r.lead_id ? 'Book meeting' : 'No matching lead'}
                            className={`${BTN_PRIMARY} px-4 py-1.5`}
                          >
                            {actingKey === key ? 'Saving…' : 'Book Meeting'}
                          </button>
                          <button
                            type="button"
                            onClick={(ev) => {
                              ev.stopPropagation()
                              act(r, key, 'mark-not-interested')
                            }}
                            disabled={actingKey === key || !r.lead_id}
                            title={r.lead_id ? 'Mark not interested' : 'No matching lead'}
                            className={`${BTN_SECONDARY} px-4 py-1.5`}
                          >
                            Not Interested
                          </button>
                          <button
                            type="button"
                            onClick={(ev) => {
                              ev.stopPropagation()
                              act(r, key, 'mark-reply-handled')
                            }}
                            disabled={actingKey === key || !r.lead_id}
                            title={
                              r.lead_id
                                ? "Dismiss without changing the lead's pipeline status (e.g. wrong_person already redirected, pricing question answered)"
                                : 'No matching lead'
                            }
                            className={`${BTN_SECONDARY} px-4 py-1.5`}
                          >
                            Dismiss
                          </button>
                        </div>
                      </td>
                    </tr>

                    {expandedKey === key && (
                      <tr className="bg-white">
                        <td colSpan={6} className="px-5 pb-5 pt-0">
                          <div className="rounded-md border border-[#E5E7EB] bg-[#F8F9FA] p-4">
                            <div className="mb-4 grid grid-cols-2 gap-4">
                              <div>
                                <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-[#9CA3AF]">
                                  Email
                                </div>
                                <div className="text-sm text-[#111827]">
                                  {r.contact_email || '—'}
                                </div>
                              </div>
                              <div>
                                <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-[#9CA3AF]">
                                  Received
                                </div>
                                <div className="text-sm text-[#111827]">
                                  {formatTimestamp(r.timestamp)}
                                </div>
                              </div>
                            </div>
                            <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-[#9CA3AF]">
                              Subject
                            </div>
                            <div className="mb-4 text-sm font-semibold text-[#111827]">
                              {r.subject || '—'}
                            </div>
                            <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-[#9CA3AF]">
                              Reply
                            </div>
                            <div className="whitespace-pre-wrap text-sm leading-relaxed text-[#6B7280]">
                              {r.body || '—'}
                            </div>

                            {r.suggested_response && (
                              <DraftBox title="Suggested response" text={r.suggested_response} />
                            )}
                            {r.referral_draft && (
                              <DraftBox
                                title={`Referral outreach${r.referral_name ? ` — ${r.referral_name}` : ''}`}
                                text={r.referral_draft}
                              />
                            )}
                            {r.assist_note && (
                              <div className="mt-4 rounded-md border border-[#E5E7EB] bg-white p-3 text-sm text-[#6B7280]">
                                <span className="font-semibold text-[#111827]">Note: </span>
                                {r.assist_note}
                              </div>
                            )}
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
    </section>
  )
}

export default Replies

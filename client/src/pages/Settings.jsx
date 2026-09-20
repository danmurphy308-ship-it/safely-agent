import { useEffect, useState } from 'react'
import api from '../api.js'
import { CARD, SkeletonBlock, SkeletonLine, ErrorBanner, getErrorMessage } from '../ui.jsx'

function Dot({ ok }) {
  return (
    <span
      className={`inline-block h-2.5 w-2.5 rounded-full ${
        ok ? 'bg-[#10B981]' : 'bg-[#D1D5DB]'
      }`}
    />
  )
}

// Parse a settings value that should be a JSON array of strings; anything
// else (missing key, bad JSON) renders as an empty list.
function parseKeywordList(value) {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((k) => typeof k === 'string') : []
  } catch {
    return []
  }
}

// One editable keyword list: removable tags plus an input to add new ones.
// Add on Enter or the Add button; every change is saved immediately by the
// parent via onChange.
function KeywordEditor({ id, label, hint, keywords, onChange, busy }) {
  const [draft, setDraft] = useState('')

  function addKeyword() {
    const keyword = draft.trim().toLowerCase()
    if (!keyword) return
    setDraft('')
    if (keywords.includes(keyword)) return
    onChange([...keywords, keyword])
  }

  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-semibold text-[#111827]">
        {label}
      </label>
      <p className="mb-3 text-xs text-[#9CA3AF]">{hint}</p>
      <div className="flex flex-wrap gap-2">
        {keywords.map((keyword) => (
          <span
            key={keyword}
            className="inline-flex items-center gap-1 rounded-full bg-[#7C3AED]/10 px-3 py-1 text-sm text-[#6D28D9]"
          >
            {keyword}
            <button
              type="button"
              onClick={() => onChange(keywords.filter((k) => k !== keyword))}
              disabled={busy}
              aria-label={`Remove ${keyword}`}
              className="rounded-full p-0.5 leading-none text-[#7C3AED] transition hover:bg-[#7C3AED]/20 disabled:opacity-50"
            >
              ×
            </button>
          </span>
        ))}
        {keywords.length === 0 && (
          <span className="text-sm text-[#9CA3AF]">No keywords — nothing is filtered.</span>
        )}
      </div>
      <div className="mt-3 flex gap-2">
        <input
          id={id}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              addKeyword()
            }
          }}
          placeholder="add a keyword…"
          disabled={busy}
          className="w-56 rounded-lg border border-[#E5E7EB] bg-white px-3 py-2 text-sm text-[#111827] placeholder-[#9CA3AF] transition focus:border-[#7C3AED] focus:outline-none focus:ring-2 focus:ring-[#7C3AED]/30 disabled:opacity-50"
        />
        <button
          type="button"
          onClick={addKeyword}
          disabled={busy || !draft.trim()}
          className="rounded-full bg-[#7C3AED] px-4 py-2 text-sm font-bold text-white transition hover:bg-[#6D28D9] disabled:cursor-not-allowed disabled:opacity-50"
        >
          Add
        </button>
      </div>
    </div>
  )
}

function Settings() {
  const [status, setStatus] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Lead Filters (bad-fit keyword lists, applied before Claude scoring).
  const [companyKeywords, setCompanyKeywords] = useState([])
  const [titleKeywords, setTitleKeywords] = useState([])
  const [filtersSaving, setFiltersSaving] = useState(false)
  const [filtersError, setFiltersError] = useState(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const [{ data: statusData }, { data: settingsData }] = await Promise.all([
        api.get('/status'),
        api.get('/settings'),
      ])
      setStatus(statusData)
      setCompanyKeywords(parseKeywordList(settingsData.filter_company_keywords))
      setTitleKeywords(parseKeywordList(settingsData.filter_title_keywords))
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  // Persist one keyword list, updating local state optimistically and rolling
  // back to the server's copy on failure.
  async function saveFilter(key, next, setLocal, previous) {
    setLocal(next)
    setFiltersSaving(true)
    setFiltersError(null)
    try {
      await api.put('/settings', { [key]: next })
    } catch (err) {
      setLocal(previous)
      setFiltersError(getErrorMessage(err))
    } finally {
      setFiltersSaving(false)
    }
  }

  return (
    <section className="mx-auto max-w-3xl">
      <header className="mb-8">
        <h1 className="text-3xl font-bold text-[#111827]">Settings</h1>
        <p className="mt-1 text-sm text-[#6B7280]">
          Environment configuration and service health.
        </p>
      </header>

      {loading && (
        <div className="space-y-6">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className={`${CARD} p-6`}>
              <SkeletonLine width="w-32" className="mb-4" />
              <SkeletonBlock className="h-4 w-48" />
            </div>
          ))}
        </div>
      )}

      {error && !loading && <ErrorBanner message={error} onRetry={load} />}

      {!loading && !error && status && (
        <div className="space-y-6">
          {/* Database */}
          <div className={`${CARD} p-6`}>
            <h2 className="mb-4 text-xs font-semibold uppercase tracking-wider text-[#6B7280]">
              Database
            </h2>
            <div className="flex items-center gap-3">
              <Dot ok={status.database.connected} />
              <span className="text-sm font-semibold text-[#111827]">
                {status.database.connected ? 'Connected' : 'Not connected'}
              </span>
            </div>
            {status.database.error && (
              <p className="mt-2 text-sm text-red-400">{status.database.error}</p>
            )}
          </div>

          {/* API keys */}
          <div className={`${CARD} p-6`}>
            <h2 className="mb-4 text-xs font-semibold uppercase tracking-wider text-[#6B7280]">
              API Keys
            </h2>
            <ul className="divide-y divide-[#E5E7EB]">
              {status.env.map((item) => (
                <li
                  key={item.key}
                  className="flex items-center justify-between py-3"
                >
                  <span className="font-mono text-sm text-[#111827]">{item.key}</span>
                  <span className="flex items-center gap-2 text-sm">
                    <Dot ok={item.configured} />
                    <span
                      className={
                        item.configured ? 'text-[#047857]' : 'text-[#9CA3AF]'
                      }
                    >
                      {item.configured ? 'Configured' : 'Not set'}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {/* Lead Filters */}
          <div className={`${CARD} p-6`}>
            <h2 className="mb-1 text-xs font-semibold uppercase tracking-wider text-[#6B7280]">
              Lead Filters
            </h2>
            <p className="mb-6 text-sm text-[#6B7280]">
              Leads whose company name or job title contains any of these
              keywords are deprioritised before AI scoring — no Claude call is
              spent on them. Changes apply to the next processing run.
            </p>

            {filtersError && (
              <p className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                {filtersError}
              </p>
            )}

            <div className="space-y-8">
              <KeywordEditor
                id="filter-company-keywords"
                label="Bad-fit company keywords"
                hint="Companies whose core business is driving/logistics — matched against the company name."
                keywords={companyKeywords}
                busy={filtersSaving}
                onChange={(next) =>
                  saveFilter(
                    'filter_company_keywords',
                    next,
                    setCompanyKeywords,
                    companyKeywords
                  )
                }
              />
              <KeywordEditor
                id="filter-title-keywords"
                label="Bad-fit title keywords"
                hint="Roles outside the ICP — matched against the contact's job title."
                keywords={titleKeywords}
                busy={filtersSaving}
                onChange={(next) =>
                  saveFilter('filter_title_keywords', next, setTitleKeywords, titleKeywords)
                }
              />
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

export default Settings

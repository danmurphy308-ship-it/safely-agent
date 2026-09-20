import { Fragment, useEffect, useRef, useState } from 'react'
import api from '../api.js'
import { CadenceEditor, AimfoxPanel } from '../components/CadenceEditor.jsx'
import {
  CARD,
  TH,
  TH_NUM,
  INPUT,
  LABEL,
  Badge,
  Avatar,
  SkeletonTable,
  getErrorMessage,
} from '../ui.jsx'

const STATUS_TONE = { active: 'green', draft: 'grey', paused: 'yellow', completed: 'grey' }

// Instantly statuses that mean "actually sending" — mirrors
// ACTIVELY_SENDING_STATUSES in src/integrations/instantly.js (1: active,
// 4: running subsequences). Anything else — completed, paused, draft,
// bounce protect, unhealthy — means a locally-active campaign is stalled,
// regardless of what its local status badge says.
const ACTIVELY_SENDING_LABELS = new Set(['active', 'running subsequences'])

// Local status is always shown as-is (it's the true DB value) — this only
// decides whether to ALSO show a "stalled" flag next to it, for a campaign
// that's active locally but not actually sending in Instantly.
function isStalled(campaign, health) {
  if (campaign.status !== 'active' || !campaign.instantly_campaign_id || !health) return false
  if (health.error) return true
  return !ACTIVELY_SENDING_LABELS.has(health.instantlyStatusLabel)
}

const EMPTY_FORM = {
  name: '',
  industries: '',
  locations: '',
  titles: '',
  minFleetSize: '100',
  instantlyCampaignId: '',
}

// Apollo lead-search criteria (separate shape: single `location` field, no name).
const EMPTY_FIND_FORM = {
  titles: '',
  industries: '',
  location: '',
  minCompanySize: '',
  perPage: '100',
}

// "a, b ,, c" -> ["a", "b", "c"]
function parseList(value) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function formatDate(value) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString()
}

function formatDateTime(value) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
}

// Short labels for process_runs job types shown in the "Last run" line.
const RUN_JOB_LABELS = {
  lead_processor: 'hourly',
  manual_process: 'manual',
  lead_replenisher: 'sourcing',
}

// Per-row "Actions" dropdown. `items` is a list of
// { key, label, onClick, danger?, separatorBefore? }. The trigger is disabled
// while any row action is running (`busy`); the active row shows `busyLabel`
// with a spinner instead of the "Actions" label.
function ActionsMenu({ isOpen, onToggle, onClose, busy, busyLabel, items }) {
  const menuRef = useRef(null)

  // Close on outside click or Escape while the menu is open.
  useEffect(() => {
    if (!isOpen) return undefined
    function onDocMouseDown(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) onClose()
    }
    function onKey(e) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [isOpen, onClose])

  return (
    <div ref={menuRef} className="relative inline-block text-left">
      <button
        type="button"
        onClick={onToggle}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        className="inline-flex items-center gap-1.5 rounded-full border border-[#E5E7EB] px-4 py-1.5 text-sm font-bold text-[#111827] transition hover:bg-[#F3F4F6] disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busyLabel ? (
          <>
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-[#E5E7EB] border-t-[#7C3AED]" />
            {busyLabel}
          </>
        ) : (
          <>
            Actions
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              className={`h-3.5 w-3.5 transition-transform ${isOpen ? 'rotate-180' : ''}`}
            >
              <path d="M6 9l6 6 6-6" />
            </svg>
          </>
        )}
      </button>

      {isOpen && !busy && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-2 w-56 origin-top-right overflow-hidden rounded-md border border-[#E5E7EB] bg-white py-1 shadow-2xl"
        >
          {items.map((item) => (
            <div key={item.key}>
              {item.separatorBefore && <div className="my-1 border-t border-[#E5E7EB]" />}
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onClose()
                  item.onClick()
                }}
                className={`flex w-full items-center px-4 py-2 text-left text-sm font-medium transition ${
                  item.danger
                    ? 'text-red-700 hover:bg-red-50'
                    : 'text-[#111827] hover:bg-[#F3F4F6]'
                }`}
              >
                {item.label}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Campaigns() {
  const [campaigns, setCampaigns] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [showModal, setShowModal] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState(null)

  const [editTarget, setEditTarget] = useState(null) // campaign being edited
  const [editTab, setEditTab] = useState('details') // 'details' | 'cadence' | 'linkedin'
  const [editForm, setEditForm] = useState(EMPTY_FORM)
  const [editSubmitting, setEditSubmitting] = useState(false)
  const [editError, setEditError] = useState(null)
  // Live Instantly sending window for the campaign being edited (read-only).
  const [editSchedule, setEditSchedule] = useState(null) // {loading, error, schedules}

  // Apollo "Find Leads" modal: search criteria, preview results, and selection.
  const [findCampaign, setFindCampaign] = useState(null) // campaign the search targets
  const [findForm, setFindForm] = useState(EMPTY_FIND_FORM)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState(null)
  const [searchResults, setSearchResults] = useState(null) // preview leads, or null before first search
  const [selectedRows, setSelectedRows] = useState(() => new Set()) // selected result indices
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState(null)
  const [findResult, setFindResult] = useState(null) // post-import summary banner { name, summary }

  const [launchingId, setLaunchingId] = useState(null)
  const [launchResult, setLaunchResult] = useState(null) // { name }
  const [launchError, setLaunchError] = useState(null)

  const [autoSourcingId, setAutoSourcingId] = useState(null)
  const [autoSourceResult, setAutoSourceResult] = useState(null) // { name, summary }
  const [autoSourceError, setAutoSourceError] = useState(null)

  const [statusUpdatingId, setStatusUpdatingId] = useState(null)
  const [statusError, setStatusError] = useState(null)

  const [uploadingId, setUploadingId] = useState(null)
  const [uploadResult, setUploadResult] = useState(null) // { name, summary }
  const [uploadError, setUploadError] = useState(null)
  const fileInputRef = useRef(null)
  const uploadTargetRef = useRef(null) // campaign chosen when the picker opened

  const [processingId, setProcessingId] = useState(null)
  const [processResult, setProcessResult] = useState(null) // live progress: { name, new, drafted, sent, done }
  const [processError, setProcessError] = useState(null)
  const pollRef = useRef(null) // interval id for process-status polling

  // Per-campaign run history from the server's process_runs ledger:
  // { [campaignId]: [{ job, drafted, deprioritised, sent, inserted, found,
  // created_at }] }, newest first. Covers the hourly automation and the
  // replenisher, not just runs triggered from this browser.
  const [processHistory, setProcessHistory] = useState({})

  async function loadProcessHistory() {
    try {
      const { data } = await api.get('/campaigns/process-runs')
      setProcessHistory(data && typeof data === 'object' ? data : {})
    } catch {
      // Non-fatal — the table renders without the "Last run" rows.
    }
  }

  // Live Instantly health per campaign (same source as the Dashboard's
  // "Needs attention" panel) — keyed by campaign id so the Status column can
  // show "stalled" instead of a bare "active" for a campaign that's actually
  // completed/paused/bounce-protected in Instantly. Read-only: this only
  // affects what's displayed, never anything sent, sourced, or resumed.
  const [campaignHealth, setCampaignHealth] = useState({})

  async function loadCampaignHealth() {
    try {
      const { data } = await api.get('/dashboard/needs-attention')
      const byId = {}
      for (const h of data?.campaignHealth ?? []) byId[h.id] = h
      setCampaignHealth(byId)
    } catch {
      // Non-fatal — the table just falls back to showing local status alone.
    }
  }

  const [deleteTarget, setDeleteTarget] = useState(null) // campaign pending confirmation
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState(null)

  const [lowScoresTarget, setLowScoresTarget] = useState(null) // campaign pending confirmation
  const [deletingLowScores, setDeletingLowScores] = useState(false)
  const [lowScoresError, setLowScoresError] = useState(null)
  const [lowScoresResult, setLowScoresResult] = useState(null) // { name, deleted }

  const [openMenuId, setOpenMenuId] = useState(null) // row whose actions menu is open

  async function loadCampaigns() {
    setLoading(true)
    setError(null)
    try {
      const { data } = await api.get('/campaigns')
      setCampaigns(data)
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadCampaigns()
    loadProcessHistory()
    loadCampaignHealth()
  }, [])

  // Open the Apollo search modal, pre-filling criteria from the campaign's saved
  // ICP as a convenient starting point (the operator can edit before searching).
  function openFindModal(campaign) {
    setFindCampaign(campaign)
    setFindForm({
      titles: (campaign.icp_titles ?? []).join(', '),
      industries: (campaign.icp_industries ?? []).join(', '),
      location: (campaign.icp_locations ?? []).join(', '),
      minCompanySize:
        campaign.icp_min_fleet_size != null ? String(campaign.icp_min_fleet_size) : '',
      perPage: '100',
    })
    setSearchResults(null)
    setSelectedRows(new Set())
    setSearchError(null)
    setImportError(null)
  }

  function closeFindModal() {
    if (searching || importing) return
    setFindCampaign(null)
    setSearchError(null)
    setImportError(null)
  }

  function updateFindField(field, value) {
    setFindForm((prev) => ({ ...prev, [field]: value }))
  }

  async function handleSearch(event) {
    event.preventDefault()
    setSearching(true)
    setSearchError(null)
    setImportError(null)
    try {
      const payload = {
        titles: parseList(findForm.titles),
        industries: parseList(findForm.industries),
        locations: parseList(findForm.location),
        perPage: Number(findForm.perPage) || 100,
      }
      if (findForm.minCompanySize !== '') {
        payload.minCompanySize = Number(findForm.minCompanySize)
      }
      const { data } = await api.post(`/campaigns/${findCampaign.id}/apollo-search`, payload)
      const leads = data.leads ?? []
      setSearchResults(leads)
      // Pre-select everything found so "import all" is a single click.
      setSelectedRows(new Set(leads.map((_, i) => i)))
    } catch (err) {
      setSearchError(getErrorMessage(err))
    } finally {
      setSearching(false)
    }
  }

  function toggleRow(index) {
    setSelectedRows((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  function toggleSelectAll() {
    setSelectedRows((prev) => {
      if (!searchResults) return prev
      if (prev.size === searchResults.length) return new Set()
      return new Set(searchResults.map((_, i) => i))
    })
  }

  async function handleImport() {
    if (!findCampaign || !searchResults) return
    const selected = searchResults.filter((_, i) => selectedRows.has(i))
    if (selected.length === 0) {
      setImportError('Select at least one lead to import.')
      return
    }
    setImporting(true)
    setImportError(null)
    try {
      const { data } = await api.post(`/campaigns/${findCampaign.id}/import-leads`, {
        leads: selected,
      })
      setFindResult({ name: findCampaign.name, summary: data })
      setFindCampaign(null)
      // total_leads changed — refresh the table.
      await loadCampaigns()
    } catch (err) {
      setImportError(getErrorMessage(err))
    } finally {
      setImporting(false)
    }
  }

  async function handleLaunchClay(campaign) {
    setLaunchingId(campaign.id)
    setLaunchError(null)
    setLaunchResult(null)
    try {
      // Fire-and-forget: Clay enriches asynchronously and posts results back to
      // the webhook callback, so there are no leads to show now — just confirm.
      await api.post(`/campaigns/${campaign.id}/launch-clay`)
      setLaunchResult({ name: campaign.name })
    } catch (err) {
      setLaunchError(getErrorMessage(err))
    } finally {
      setLaunchingId(null)
    }
  }

  // Activate/pause a campaign. 'active' is the on-switch for the hourly jobs
  // (auto-replenish sourcing + scoring/drafting); draft/paused campaigns are
  // only ever worked manually.
  async function handleSetStatus(campaign, status) {
    setStatusUpdatingId(campaign.id)
    setStatusError(null)
    try {
      await api.patch(`/campaigns/${campaign.id}/status`, { status })
      await loadCampaigns()
    } catch (err) {
      setStatusError(getErrorMessage(err))
    } finally {
      setStatusUpdatingId(null)
    }
  }

  // One-click sourcing: server walks Apollo pages from the campaign's saved
  // cursor until ~25 leads actually make it past enrichment, blacklist,
  // HubSpot, and dedupe — no preview/selection step. Can take a minute.
  async function handleAutoSource(campaign) {
    setAutoSourcingId(campaign.id)
    setAutoSourceError(null)
    setAutoSourceResult(null)
    try {
      const { data } = await api.post(`/campaigns/${campaign.id}/find-leads`)
      setAutoSourceResult({ name: campaign.name, summary: data })
      if (data.inserted > 0) {
        await loadCampaigns()
      }
    } catch (err) {
      setAutoSourceError(getErrorMessage(err))
    } finally {
      setAutoSourcingId(null)
    }
  }

  // Remember which campaign the upload is for, then open the OS file picker.
  function openCsvPicker(campaign) {
    uploadTargetRef.current = campaign
    if (fileInputRef.current) {
      fileInputRef.current.value = '' // allow re-selecting the same file
      fileInputRef.current.click()
    }
  }

  async function handleCsvSelected(event) {
    const file = event.target.files?.[0]
    const campaign = uploadTargetRef.current
    if (!file || !campaign) return

    setUploadingId(campaign.id)
    setUploadError(null)
    setUploadResult(null)
    try {
      const formData = new FormData()
      formData.append('file', file)
      const { data } = await api.post(`/campaigns/${campaign.id}/upload-csv`, formData)
      setUploadResult({ name: campaign.name, summary: data })
      // New/updated leads changed the counts — refresh the table.
      if (data.inserted > 0 || data.updated > 0) {
        await loadCampaigns()
      }
    } catch (err) {
      setUploadError(getErrorMessage(err))
    } finally {
      setUploadingId(null)
      uploadTargetRef.current = null
    }
  }

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }

  // Poll process-status; stop and refresh once the background run finishes.
  async function pollProcessStatus(campaign) {
    try {
      const { data } = await api.get(`/campaigns/${campaign.id}/process-status`)
      if (!data.processing) {
        stopPolling()
        setProcessingId(null)
        // Run finished: the server ledgered it in process_runs — refresh the
        // history so the per-row "Last run" line shows the actual run deltas.
        await loadProcessHistory()
        setProcessResult(null)
        // Counts/statuses changed — refresh the table.
        await loadCampaigns()
      } else {
        setProcessResult({
          name: campaign.name,
          new: data.new,
          drafted: data.drafted,
          sent: data.sent,
          done: false,
        })
      }
    } catch (err) {
      stopPolling()
      setProcessingId(null)
      setProcessError(getErrorMessage(err))
    }
  }

  async function handleProcessLeads(campaign) {
    setProcessingId(campaign.id)
    setProcessError(null)
    setProcessResult(null)
    try {
      // Kick off background processing; the request returns 202 immediately.
      await api.post(`/campaigns/${campaign.id}/process-leads`)
      // Then poll for progress until it reports done.
      stopPolling()
      pollRef.current = setInterval(() => pollProcessStatus(campaign), 5000)
      pollProcessStatus(campaign)
    } catch (err) {
      setProcessError(getErrorMessage(err))
      setProcessingId(null)
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    setDeleteError(null)
    try {
      await api.delete(`/campaigns/${deleteTarget.id}`)
      setDeleteTarget(null)
      await loadCampaigns()
    } catch (err) {
      setDeleteError(getErrorMessage(err))
    } finally {
      setDeleting(false)
    }
  }

  async function handleDeleteLowScores() {
    if (!lowScoresTarget) return
    setDeletingLowScores(true)
    setLowScoresError(null)
    try {
      const { data } = await api.delete(`/campaigns/${lowScoresTarget.id}/low-scores`)
      setLowScoresResult({ name: lowScoresTarget.name, deleted: data.deleted })
      setLowScoresTarget(null)
      // total_leads changed — refresh the table.
      await loadCampaigns()
    } catch (err) {
      setLowScoresError(getErrorMessage(err))
    } finally {
      setDeletingLowScores(false)
    }
  }

  // Close the modal on Escape.
  useEffect(() => {
    if (!showModal) return undefined
    function onKey(e) {
      if (e.key === 'Escape') closeModal()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showModal])

  // Close the edit modal on Escape.
  useEffect(() => {
    if (!editTarget) return undefined
    function onKey(e) {
      if (e.key === 'Escape') closeEditModal()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editTarget])

  // Close the find-leads modal on Escape.
  useEffect(() => {
    if (!findCampaign) return undefined
    function onKey(e) {
      if (e.key === 'Escape') closeFindModal()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [findCampaign])

  // Stop any in-flight status polling when the page unmounts.
  useEffect(() => {
    return () => stopPolling()
  }, [])

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
    if (!form.name.trim()) {
      setSubmitError('Campaign name is required.')
      return
    }

    setSubmitting(true)
    setSubmitError(null)

    const payload = {
      name: form.name.trim(),
      icp_industries: parseList(form.industries),
      icp_locations: parseList(form.locations),
      icp_titles: parseList(form.titles),
      instantly_campaign_id: form.instantlyCampaignId.trim(),
    }
    if (form.minFleetSize !== '') {
      payload.icp_min_fleet_size = Number(form.minFleetSize)
    }

    try {
      await api.post('/campaigns', payload)
      setShowModal(false)
      await loadCampaigns()
    } catch (err) {
      setSubmitError(getErrorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  // Friendly names for Instantly's coarse timezone enum values (it has no
// Europe/London — Atlantic/Canary is its UK/Ireland-time value).
const TZ_LABELS = {
  'Atlantic/Canary': 'UK & Ireland time',
  'America/Chicago': 'US Central',
  'America/New_York': 'US Eastern',
  'America/Los_Angeles': 'US Pacific',
}

// Collapse an Instantly days object ({0..6: bool}) into e.g. "Mon–Fri".
function formatScheduleDays(days) {
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const active = names.map((n, i) => (days?.[i] || days?.[String(i)] ? n : null))
  const on = active.filter(Boolean)
  if (on.length === 0) return 'no days'
  // Contiguous run → range; otherwise list them.
  const idx = active.map((n, i) => (n ? i : null)).filter((v) => v != null)
  const contiguous = idx.every((v, k) => k === 0 || v === idx[k - 1] + 1)
  return contiguous && on.length > 2 ? `${on[0]}–${on[on.length - 1]}` : on.join(', ')
}

// Open the edit modal pre-filled with the campaign's current values. The ICP
  // list fields are stored as arrays, so join them back into comma-separated
  // text for the inputs (parseList reverses this on save).
  function openEditModal(campaign) {
    setEditTarget(campaign)
    setEditTab('details')
    setEditForm({
      name: campaign.name ?? '',
      industries: (campaign.icp_industries ?? []).join(', '),
      locations: (campaign.icp_locations ?? []).join(', '),
      titles: (campaign.icp_titles ?? []).join(', '),
      minFleetSize:
        campaign.icp_min_fleet_size != null ? String(campaign.icp_min_fleet_size) : '',
      instantlyCampaignId: campaign.instantly_campaign_id ?? '',
      aimfoxCampaignId: campaign.aimfox_campaign_id ?? '',
      leadSource: campaign.lead_source ?? 'apollo',
      autoReplenish: campaign.auto_replenish ?? false,
      replenishThreshold:
        campaign.replenish_threshold != null ? String(campaign.replenish_threshold) : '25',
    })
    setEditError(null)

    // Pull the live Instantly sending window (best-effort, read-only) so a
    // wrong schedule/timezone is visible without opening Instantly.
    setEditSchedule({ loading: true })
    api
      .get(`/campaigns/${campaign.id}/sending-schedule`)
      .then(({ data }) => setEditSchedule({ schedules: data.schedules || [] }))
      .catch((err) =>
        setEditSchedule({
          error:
            err?.response?.status === 404
              ? 'No Instantly campaign linked.'
              : getErrorMessage(err),
        })
      )
  }

  function closeEditModal() {
    if (editSubmitting) return
    setEditTarget(null)
    setEditError(null)
  }

  function updateEditField(field, value) {
    setEditForm((prev) => ({ ...prev, [field]: value }))
  }

  async function handleEditSubmit(event) {
    event.preventDefault()
    if (!editForm.name.trim()) {
      setEditError('Campaign name is required.')
      return
    }

    setEditSubmitting(true)
    setEditError(null)

    const payload = {
      name: editForm.name.trim(),
      icp_industries: parseList(editForm.industries),
      icp_locations: parseList(editForm.locations),
      icp_titles: parseList(editForm.titles),
      instantly_campaign_id: editForm.instantlyCampaignId.trim(),
      aimfox_campaign_id: editForm.aimfoxCampaignId.trim(),
      lead_source: editForm.leadSource,
      auto_replenish: editForm.autoReplenish,
    }
    if (editForm.minFleetSize !== '') {
      payload.icp_min_fleet_size = Number(editForm.minFleetSize)
    }
    if (editForm.replenishThreshold !== '') {
      payload.replenish_threshold = Number(editForm.replenishThreshold)
    }

    try {
      await api.put(`/campaigns/${editTarget.id}`, payload)
      setEditTarget(null)
      await loadCampaigns()
    } catch (err) {
      setEditError(getErrorMessage(err))
    } finally {
      setEditSubmitting(false)
    }
  }

  // Row actions are mutually exclusive — only one long-running operation at a time.
  // (Apollo "Find Leads" runs inside its own modal, so it isn't a row-busy action.)
  const anyActionBusy =
    processingId !== null ||
    launchingId !== null ||
    uploadingId !== null ||
    autoSourcingId !== null ||
    statusUpdatingId !== null

  // Per-row in-flight label shown on the Actions trigger while an action runs.
  function rowBusyLabel(campaign) {
    if (launchingId === campaign.id) return 'Launching…'
    if (uploadingId === campaign.id) return 'Uploading…'
    if (processingId === campaign.id) return 'Processing…'
    if (autoSourcingId === campaign.id) return 'Sourcing…'
    if (statusUpdatingId === campaign.id) return 'Updating…'
    return null
  }

  return (
    <section className="mx-auto max-w-6xl">
      {/* Hidden file input shared by every row's "Upload CSV" button. */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".csv,text/csv"
        onChange={handleCsvSelected}
        className="hidden"
      />
      {/* Header */}
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-[#111827]">Campaigns</h1>
          <p className="mt-1 text-sm text-[#6B7280]">
            Manage your targeting campaigns and track outreach progress.
          </p>
        </div>
        <button
          type="button"
          onClick={openModal}
          className="inline-flex items-center gap-2 rounded-full bg-[#7C3AED] px-6 py-2.5 text-sm font-bold text-white transition hover:scale-105 hover:bg-[#6D28D9] focus:outline-none focus:ring-2 focus:ring-[#7C3AED]/50"
        >
          <span className="text-base leading-none">+</span>
          Create Campaign
        </button>
      </header>

      {/* Loading */}
      {loading && <SkeletonTable rows={6} cols={7} />}

      {/* Error */}
      {error && !loading && (
        <div className="flex items-center justify-between gap-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <span>{error}</span>
          <button
            type="button"
            onClick={loadCampaigns}
            className="rounded-full border border-red-300 px-4 py-1.5 font-semibold text-red-700 transition hover:bg-red-50"
          >
            Retry
          </button>
        </div>
      )}

      {/* Apollo import summary */}
      {findResult && (
        <div className="mb-4 flex items-center justify-between gap-4 rounded-lg border border-[#7C3AED]/30 bg-[#7C3AED]/10 px-4 py-3 text-sm text-[#6B7280]">
          <div>
            <span className="font-semibold text-[#111827]">{findResult.name}</span>
            {' — imported '}
            <span className="font-semibold text-[#7C3AED]">
              {findResult.summary.inserted}
            </span>
            {' of '}
            <span className="font-semibold text-[#111827]">{findResult.summary.received}</span>
            {' selected ('}
            {findResult.summary.duplicates} duplicate, {findResult.summary.blacklisted}{' '}
            blacklisted
            {findResult.summary.skipped > 0 && `, ${findResult.summary.skipped} skipped`})
          </div>
          <button
            type="button"
            onClick={() => setFindResult(null)}
            aria-label="Dismiss"
            className="rounded-md p-1 text-[#6B7280] transition hover:bg-[#F3F4F6] hover:text-[#111827]"
          >
            <span className="text-lg leading-none">×</span>
          </button>
        </div>
      )}

      {/* Launch-in-Clay error */}
      {launchError && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {launchError}
        </div>
      )}

      {/* Launch-in-Clay success */}
      {launchResult && (
        <div className="mb-4 flex items-center justify-between gap-4 rounded-lg border border-[#7C3AED]/30 bg-[#7C3AED]/10 px-4 py-3 text-sm text-[#6B7280]">
          <div>
            <span className="font-semibold text-[#111827]">{launchResult.name}</span>
            {' — '}
            Clay search launched — leads will appear automatically when enriched
          </div>
          <button
            type="button"
            onClick={() => setLaunchResult(null)}
            aria-label="Dismiss"
            className="rounded-md p-1 text-[#6B7280] transition hover:bg-[#F3F4F6] hover:text-[#111827]"
          >
            <span className="text-lg leading-none">×</span>
          </button>
        </div>
      )}

      {/* Activate/pause error */}
      {statusError && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {statusError}
        </div>
      )}

      {/* Auto-source error */}
      {autoSourceError && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {autoSourceError}
        </div>
      )}

      {/* Auto-source summary */}
      {autoSourceResult && (
        <div className="mb-4 flex items-center justify-between gap-4 rounded-lg border border-[#7C3AED]/30 bg-[#7C3AED]/10 px-4 py-3 text-sm text-[#6B7280]">
          <div>
            <span className="font-semibold text-[#111827]">{autoSourceResult.name}</span>
            {' — auto-sourced: '}
            <span className="font-semibold text-[#7C3AED]">
              {autoSourceResult.summary.inserted}
            </span>
            {' new lead(s) from '}
            <span className="font-semibold text-[#111827]">
              {autoSourceResult.summary.found}
            </span>
            {` found across ${autoSourceResult.summary.pages} page(s)`}
            {autoSourceResult.summary.duplicates > 0 &&
              ` (${autoSourceResult.summary.duplicates} duplicate)`}
            {autoSourceResult.summary.blacklisted > 0 &&
              ` (${autoSourceResult.summary.blacklisted} blacklisted)`}
            {autoSourceResult.summary.exhausted &&
              ' — Apollo has no more matches for this ICP'}
          </div>
          <button
            type="button"
            onClick={() => setAutoSourceResult(null)}
            aria-label="Dismiss"
            className="rounded-md p-1 text-[#6B7280] transition hover:bg-[#F3F4F6] hover:text-[#111827]"
          >
            <span className="text-lg leading-none">×</span>
          </button>
        </div>
      )}

      {/* CSV-upload error */}
      {uploadError && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {uploadError}
        </div>
      )}

      {/* CSV-upload summary */}
      {uploadResult && (
        <div className="mb-4 flex items-center justify-between gap-4 rounded-lg border border-[#7C3AED]/30 bg-[#7C3AED]/10 px-4 py-3 text-sm text-[#6B7280]">
          <div>
            <span className="font-semibold text-[#111827]">{uploadResult.name}</span>
            {' — CSV imported: '}
            inserted{' '}
            <span className="font-semibold text-[#7C3AED]">
              {uploadResult.summary.inserted}
            </span>
            , updated{' '}
            <span className="font-semibold text-[#111827]">{uploadResult.summary.updated}</span>
            , duplicate{' '}
            <span className="font-semibold text-[#111827]">
              {uploadResult.summary.duplicates}
            </span>
            {uploadResult.summary.blacklisted > 0 &&
              ` (${uploadResult.summary.blacklisted} blacklisted)`}
            {uploadResult.summary.skipped > 0 &&
              ` (${uploadResult.summary.skipped} skipped — no company name)`}
          </div>
          <button
            type="button"
            onClick={() => setUploadResult(null)}
            aria-label="Dismiss"
            className="rounded-md p-1 text-[#6B7280] transition hover:bg-[#F3F4F6] hover:text-[#111827]"
          >
            <span className="text-lg leading-none">×</span>
          </button>
        </div>
      )}

      {/* Process-leads error */}
      {processError && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {processError}
        </div>
      )}

      {/* Process-leads live progress (auto-clears on completion; the final
          result is shown persistently under each campaign row). */}
      {processResult && (
        <div className="mb-4 flex items-center gap-3 rounded-lg border border-[#7C3AED]/30 bg-[#7C3AED]/10 px-4 py-3 text-sm text-[#6B7280]">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-[#E5E7EB] border-t-[#7C3AED]" />
          <span>
            <span className="font-semibold text-[#111827]">{processResult.name}</span>
            {' — processing… '}
            <span className="font-semibold text-[#7C3AED]">{processResult.drafted}</span>{' '}
            drafted,{' '}
            <span className="font-semibold text-[#111827]">{processResult.new}</span>{' '}
            still new
          </span>
        </div>
      )}

      {/* Delete-low-scores error */}
      {lowScoresError && !lowScoresTarget && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {lowScoresError}
        </div>
      )}

      {/* Delete-low-scores summary */}
      {lowScoresResult && (
        <div className="mb-4 flex items-center justify-between gap-4 rounded-lg border border-[#7C3AED]/30 bg-[#7C3AED]/10 px-4 py-3 text-sm text-[#6B7280]">
          <div>
            <span className="font-semibold text-[#111827]">{lowScoresResult.name}</span>
            {' — deleted '}
            <span className="font-semibold text-[#111827]">{lowScoresResult.deleted}</span>{' '}
            low-scoring lead(s)
          </div>
          <button
            type="button"
            onClick={() => setLowScoresResult(null)}
            aria-label="Dismiss"
            className="rounded-md p-1 text-[#6B7280] transition hover:bg-[#F3F4F6] hover:text-[#111827]"
          >
            <span className="text-lg leading-none">×</span>
          </button>
        </div>
      )}

      {/* Empty */}
      {!loading && !error && campaigns.length === 0 && (
        <div className="rounded-lg border border-dashed border-[#E5E7EB] bg-white py-16 text-center">
          <p className="text-sm text-[#6B7280]">No campaigns yet.</p>
          <button
            type="button"
            onClick={openModal}
            className="mt-3 text-sm font-bold text-[#7C3AED] hover:text-[#6D28D9]"
          >
            Create your first campaign
          </button>
        </div>
      )}

      {/* Table */}
      {!loading && !error && campaigns.length > 0 && (
        <div className={`overflow-x-auto ${CARD}`}>
          <table className="min-w-full">
            <thead className="border-b border-[#E5E7EB]">
              <tr>
                <th className={TH}>Name</th>
                <th className={TH}>Status</th>
                <th className={TH_NUM}>Leads</th>
                <th className={TH_NUM}>Contacted</th>
                <th className={TH_NUM}>Replied</th>
                <th className={TH_NUM}>Meetings</th>
                <th className={TH}>Created</th>
                <th className={`${TH} text-right`}>Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E5E7EB]">
              {campaigns.map((c) => {
                const history = processHistory[c.id] ?? []
                const lastRun = history[0]
                const olderRuns = history.slice(1)
                const health = campaignHealth[c.id]
                const stalled = isStalled(c, health)
                return (
                  <Fragment key={c.id}>
                <tr className="transition hover:bg-[#F9FAFB]">
                  <td className="px-5 py-4 text-sm font-semibold text-[#111827]">
                    <div className="flex items-center gap-2.5">
                      <Avatar name={c.name} size="sm" />
                      <span>{c.name}</span>
                    </div>
                  </td>
                  <td className="px-5 py-4 text-sm">
                    <Badge tone={STATUS_TONE[c.status] || 'grey'}>{c.status}</Badge>
                    {stalled && (
                      <div className="mt-1">
                        <Badge tone="red">
                          stalled — {health.error ? 'check failed' : health.instantlyStatusLabel}
                        </Badge>
                      </div>
                    )}
                  </td>
                  <td className="px-5 py-4 text-right text-sm tabular-nums text-[#6B7280]">
                    {c.total_leads ?? 0}
                  </td>
                  <td className="px-5 py-4 text-right text-sm tabular-nums text-[#6B7280]">
                    {c.total_contacted ?? 0}
                  </td>
                  <td className="px-5 py-4 text-right text-sm tabular-nums text-[#6B7280]">
                    {c.total_replied ?? 0}
                  </td>
                  <td className="px-5 py-4 text-right text-sm tabular-nums text-[#6B7280]">
                    {c.total_meetings ?? 0}
                  </td>
                  <td className="px-5 py-4 text-sm text-[#9CA3AF]">
                    {formatDate(c.created_at)}
                  </td>
                  <td className="px-5 py-4">
                    <div className="flex justify-end">
                      <ActionsMenu
                        isOpen={openMenuId === c.id}
                        onToggle={() =>
                          setOpenMenuId((prev) => (prev === c.id ? null : c.id))
                        }
                        onClose={() => setOpenMenuId(null)}
                        busy={anyActionBusy}
                        busyLabel={rowBusyLabel(c)}
                        items={[
                          // Master on/off switch for the campaign's automation:
                          // active campaigns can be paused; anything else can
                          // be activated.
                          c.status === 'active'
                            ? {
                                key: 'pause',
                                label: 'Pause Campaign',
                                onClick: () => handleSetStatus(c, 'paused'),
                              }
                            : {
                                key: 'activate',
                                label: 'Activate Campaign',
                                onClick: () => handleSetStatus(c, 'active'),
                              },
                          {
                            key: 'find',
                            label: 'Find Leads',
                            separatorBefore: true,
                            onClick: () => openFindModal(c),
                          },
                          {
                            key: 'auto-source',
                            label: 'Auto-Source 25 Leads',
                            onClick: () => handleAutoSource(c),
                          },
                          {
                            key: 'clay',
                            label: 'Launch in Clay',
                            onClick: () => handleLaunchClay(c),
                          },
                          {
                            key: 'csv',
                            label: 'Upload CSV',
                            onClick: () => openCsvPicker(c),
                          },
                          {
                            key: 'process',
                            label: 'Process Leads',
                            onClick: () => handleProcessLeads(c),
                          },
                          {
                            key: 'edit',
                            label: 'Edit Campaign',
                            separatorBefore: true,
                            onClick: () => openEditModal(c),
                          },
                          {
                            key: 'low-scores',
                            label: 'Delete Low Scores',
                            separatorBefore: true,
                            danger: true,
                            onClick: () => {
                              setLowScoresError(null)
                              setLowScoresTarget(c)
                            },
                          },
                          {
                            key: 'delete',
                            label: 'Delete Campaign',
                            danger: true,
                            onClick: () => {
                              setDeleteError(null)
                              setDeleteTarget(c)
                            },
                          },
                        ]}
                      />
                    </div>
                  </td>
                </tr>
                {lastRun && (
                  <tr className="bg-[#FAFAFB]">
                    <td colSpan={8} className="px-5 pb-4 pt-0">
                      <p className="text-sm text-[#6B7280]">
                        <span className="font-medium text-[#111827]">
                          Last run ({RUN_JOB_LABELS[lastRun.job] ?? lastRun.job}):
                        </span>{' '}
                        {lastRun.job === 'lead_replenisher' ? (
                          <>
                            <span className="font-semibold text-[#7C3AED]">
                              {lastRun.inserted}
                            </span>{' '}
                            leads sourced ({lastRun.found} found)
                          </>
                        ) : (
                          <>
                            <span className="font-semibold text-[#7C3AED]">
                              {lastRun.drafted}
                            </span>{' '}
                            drafted,{' '}
                            <span className="font-semibold text-[#111827]">
                              {lastRun.deprioritised}
                            </span>{' '}
                            deprioritised,{' '}
                            <span className="font-semibold text-[#111827]">{lastRun.sent}</span>{' '}
                            sent to Instantly
                          </>
                        )}
                        <span className="ml-2 text-xs text-[#9CA3AF]">
                          ({formatDateTime(lastRun.created_at)})
                        </span>
                      </p>
                      {olderRuns.length > 0 && (
                        <div className="mt-1.5">
                          <p className="text-xs font-medium uppercase tracking-wide text-[#9CA3AF]">
                            Earlier runs
                          </p>
                          <ul className="mt-0.5 space-y-0.5 text-xs text-[#9CA3AF]">
                            {olderRuns.map((run, i) => (
                              <li key={i}>
                                {formatDateTime(run.created_at)} (
                                {RUN_JOB_LABELS[run.job] ?? run.job}) —{' '}
                                {run.job === 'lead_replenisher'
                                  ? `${run.inserted} leads sourced (${run.found} found)`
                                  : `${run.drafted} drafted, ${run.deprioritised} deprioritised, ${run.sent} sent to Instantly`}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
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

      {/* Create modal */}
      {showModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onMouseDown={closeModal}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-campaign-title"
            className="w-full max-w-lg rounded-xl bg-white shadow-2xl"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-[#E5E7EB] px-6 py-4">
              <h2
                id="create-campaign-title"
                className="text-lg font-bold text-[#111827]"
              >
                Create campaign
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
                  <label htmlFor="name" className={LABEL}>
                    Campaign name
                  </label>
                  <input
                    id="name"
                    type="text"
                    value={form.name}
                    onChange={(e) => updateField('name', e.target.value)}
                    placeholder="e.g. UK Utilities Q3"
                    className={INPUT}
                    required
                  />
                </div>

                <div>
                  <label htmlFor="industries" className={LABEL}>
                    Target industries
                  </label>
                  <input
                    id="industries"
                    type="text"
                    value={form.industries}
                    onChange={(e) => updateField('industries', e.target.value)}
                    placeholder="comma separated, e.g. utilities, telecoms"
                    className={INPUT}
                  />
                </div>

                <div>
                  <label htmlFor="locations" className={LABEL}>
                    Target locations
                  </label>
                  <input
                    id="locations"
                    type="text"
                    value={form.locations}
                    onChange={(e) => updateField('locations', e.target.value)}
                    placeholder="comma separated, e.g. UK, USA"
                    className={INPUT}
                  />
                </div>

                <div>
                  <label htmlFor="titles" className={LABEL}>
                    Target job titles
                  </label>
                  <input
                    id="titles"
                    type="text"
                    value={form.titles}
                    onChange={(e) => updateField('titles', e.target.value)}
                    placeholder="comma separated, e.g. Fleet Manager, Operations Director"
                    className={INPUT}
                  />
                </div>

                <div>
                  <label htmlFor="minFleetSize" className={LABEL}>
                    Minimum fleet size
                  </label>
                  <input
                    id="minFleetSize"
                    type="number"
                    min="0"
                    value={form.minFleetSize}
                    onChange={(e) => updateField('minFleetSize', e.target.value)}
                    className={INPUT}
                  />
                </div>

                <div>
                  <label htmlFor="instantlyCampaignId" className={LABEL}>
                    Instantly campaign ID
                  </label>
                  <input
                    id="instantlyCampaignId"
                    type="text"
                    value={form.instantlyCampaignId}
                    onChange={(e) => updateField('instantlyCampaignId', e.target.value)}
                    placeholder="paste the Instantly campaign UUID (optional)"
                    className={INPUT}
                  />
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
                  className="rounded-full border border-[#E5E7EB] bg-white px-6 py-2.5 text-sm font-bold text-[#111827] transition hover:bg-[#F3F4F6] disabled:opacity-60"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="inline-flex items-center rounded-full bg-[#7C3AED] px-6 py-2.5 text-sm font-bold text-white transition hover:bg-[#6D28D9] focus:outline-none focus:ring-2 focus:ring-[#7C3AED]/50 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {submitting ? 'Creating…' : 'Create campaign'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit modal */}
      {editTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onMouseDown={closeEditModal}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="edit-campaign-title"
            className={`flex max-h-[90vh] w-full flex-col rounded-xl bg-white shadow-2xl ${
              editTab === 'details' ? 'max-w-lg' : 'max-w-3xl'
            }`}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-[#E5E7EB] px-6 py-4">
              <h2 id="edit-campaign-title" className="text-lg font-bold text-[#111827]">
                Edit campaign
                <span className="ml-2 font-normal text-[#6B7280]">— {editTarget.name}</span>
              </h2>
              <button
                type="button"
                onClick={closeEditModal}
                aria-label="Close"
                className="rounded-md p-1 text-[#6B7280] transition hover:bg-[#F3F4F6] hover:text-[#111827]"
              >
                <span className="text-xl leading-none">×</span>
              </button>
            </div>

            <div className="flex gap-1 border-b border-[#E5E7EB] px-6 pt-3">
              {[
                { key: 'details', label: 'Details' },
                { key: 'cadence', label: 'Cadence' },
                { key: 'linkedin', label: 'LinkedIn' },
              ].map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setEditTab(tab.key)}
                  className={`rounded-t-md px-4 py-2 text-sm font-semibold transition ${
                    editTab === tab.key
                      ? 'border-b-2 border-[#7C3AED] text-[#7C3AED]'
                      : 'text-[#6B7280] hover:text-[#111827]'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {editTab === 'cadence' && (
              <div className="flex-1 overflow-y-auto px-6 py-5">
                <CadenceEditor campaignId={editTarget.id} />
              </div>
            )}
            {editTab === 'linkedin' && (
              <div className="flex-1 overflow-y-auto px-6 py-5">
                <AimfoxPanel campaignId={editTarget.id} />
              </div>
            )}

            {editTab === 'details' && (
            <form onSubmit={handleEditSubmit} className="flex-1 overflow-y-auto px-6 py-5">
              <div className="space-y-4">
                <div>
                  <label htmlFor="edit-name" className={LABEL}>
                    Campaign name
                  </label>
                  <input
                    id="edit-name"
                    type="text"
                    value={editForm.name}
                    onChange={(e) => updateEditField('name', e.target.value)}
                    placeholder="e.g. UK Utilities Q3"
                    className={INPUT}
                    required
                  />
                </div>

                <div>
                  <label htmlFor="edit-industries" className={LABEL}>
                    Target industries
                  </label>
                  <input
                    id="edit-industries"
                    type="text"
                    value={editForm.industries}
                    onChange={(e) => updateEditField('industries', e.target.value)}
                    placeholder="comma separated, e.g. utilities, telecoms"
                    className={INPUT}
                  />
                </div>

                <div>
                  <label htmlFor="edit-locations" className={LABEL}>
                    Target locations
                  </label>
                  <input
                    id="edit-locations"
                    type="text"
                    value={editForm.locations}
                    onChange={(e) => updateEditField('locations', e.target.value)}
                    placeholder="comma separated, e.g. UK, USA"
                    className={INPUT}
                  />
                </div>

                <div>
                  <label htmlFor="edit-titles" className={LABEL}>
                    Target job titles
                  </label>
                  <input
                    id="edit-titles"
                    type="text"
                    value={editForm.titles}
                    onChange={(e) => updateEditField('titles', e.target.value)}
                    placeholder="comma separated, e.g. Fleet Manager, Operations Director"
                    className={INPUT}
                  />
                </div>

                <div>
                  <label htmlFor="edit-minFleetSize" className={LABEL}>
                    Minimum fleet size
                  </label>
                  <input
                    id="edit-minFleetSize"
                    type="number"
                    min="0"
                    value={editForm.minFleetSize}
                    onChange={(e) => updateEditField('minFleetSize', e.target.value)}
                    className={INPUT}
                  />
                </div>

                <div>
                  <label htmlFor="edit-instantlyCampaignId" className={LABEL}>
                    Instantly campaign ID
                  </label>
                  <input
                    id="edit-instantlyCampaignId"
                    type="text"
                    value={editForm.instantlyCampaignId}
                    onChange={(e) => updateEditField('instantlyCampaignId', e.target.value)}
                    placeholder="paste the Instantly campaign UUID (optional)"
                    className={INPUT}
                  />

                  {/* Live sending window from Instantly — read-only, so a
                      wrong timezone is visible without opening Instantly. */}
                  <div className="mt-2 rounded-lg border border-[#E5E7EB] bg-[#F8F9FA] px-3 py-2 text-xs text-[#6B7280]">
                    <span className="font-semibold uppercase tracking-wider text-[#9CA3AF]">
                      Sending window
                    </span>{' '}
                    {editSchedule?.loading && 'loading from Instantly…'}
                    {editSchedule?.error && editSchedule.error}
                    {editSchedule?.schedules &&
                      (editSchedule.schedules.length === 0
                        ? 'No schedule set in Instantly.'
                        : editSchedule.schedules
                            .map(
                              (s) =>
                                `${formatScheduleDays(s.days)} ${s.timing?.from ?? '?'}–${
                                  s.timing?.to ?? '?'
                                } · ${TZ_LABELS[s.timezone] || s.timezone} (${s.timezone})`
                            )
                            .join(' | '))}
                  </div>
                </div>

                <div>
                  <label htmlFor="edit-aimfoxCampaignId" className={LABEL}>
                    Aimfox campaign ID
                  </label>
                  <input
                    id="edit-aimfoxCampaignId"
                    type="text"
                    value={editForm.aimfoxCampaignId}
                    onChange={(e) => updateEditField('aimfoxCampaignId', e.target.value)}
                    placeholder="paste the Aimfox campaign UUID (optional)"
                    className={INPUT}
                  />
                  <p className="mt-1 text-xs text-[#9CA3AF]">
                    LinkedIn campaigns must be created in Aimfox first, then paste the campaign ID
                    here — they can't be auto-created via API.
                  </p>
                </div>

                <div>
                  <label htmlFor="edit-leadSource" className={LABEL}>
                    Lead source
                  </label>
                  <select
                    id="edit-leadSource"
                    value={editForm.leadSource}
                    onChange={(e) => updateEditField('leadSource', e.target.value)}
                    className={INPUT}
                  >
                    <option value="apollo">Apollo</option>
                    <option value="clay">Clay</option>
                  </select>
                  <p className="mt-1 text-xs text-[#9CA3AF]">
                    Provider used by Auto-Source and auto-replenish. Clay needs
                    CLAY_PUBLIC_API_KEY configured on the server.
                  </p>
                </div>

                <div>
                  <label htmlFor="edit-autoReplenish" className={LABEL}>
                    Auto-replenish leads
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      id="edit-autoReplenish"
                      type="checkbox"
                      checked={editForm.autoReplenish}
                      onChange={(e) => updateEditField('autoReplenish', e.target.checked)}
                      className="h-4 w-4 rounded border-[#E5E7EB] text-[#7C3AED] focus:ring-2 focus:ring-[#7C3AED]/30"
                    />
                    <span className="text-sm text-[#6B7280]">
                      Top up from Apollo when unsent pipeline drops below
                    </span>
                    <input
                      id="edit-replenishThreshold"
                      type="number"
                      min="1"
                      value={editForm.replenishThreshold}
                      onChange={(e) => updateEditField('replenishThreshold', e.target.value)}
                      disabled={!editForm.autoReplenish}
                      className={`${INPUT} w-20 disabled:opacity-50`}
                      style={{ width: '5rem' }}
                    />
                    <span className="text-sm text-[#6B7280]">leads (max once per day)</span>
                  </div>
                  <p className="mt-1 text-xs text-[#9CA3AF]">
                    Spends Apollo credits. Only runs while the campaign is active.
                  </p>
                </div>
              </div>

              {editError && (
                <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                  {editError}
                </p>
              )}

              <div className="mt-6 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={closeEditModal}
                  disabled={editSubmitting}
                  className="rounded-full border border-[#E5E7EB] bg-white px-6 py-2.5 text-sm font-bold text-[#111827] transition hover:bg-[#F3F4F6] disabled:opacity-60"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={editSubmitting}
                  className="inline-flex items-center rounded-full bg-[#7C3AED] px-6 py-2.5 text-sm font-bold text-white transition hover:bg-[#6D28D9] focus:outline-none focus:ring-2 focus:ring-[#7C3AED]/50 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {editSubmitting ? 'Saving…' : 'Save changes'}
                </button>
              </div>
            </form>
            )}
          </div>
        </div>
      )}

      {/* Find Leads (Apollo) modal */}
      {findCampaign && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onMouseDown={closeFindModal}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="find-leads-title"
            className="flex max-h-[90vh] w-full max-w-4xl flex-col rounded-xl bg-white shadow-2xl"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-[#E5E7EB] px-6 py-4">
              <h2 id="find-leads-title" className="text-lg font-bold text-[#111827]">
                Find leads via Apollo
                <span className="ml-2 font-normal text-[#6B7280]">— {findCampaign.name}</span>
              </h2>
              <button
                type="button"
                onClick={closeFindModal}
                aria-label="Close"
                className="rounded-md p-1 text-[#6B7280] transition hover:bg-[#F3F4F6] hover:text-[#111827]"
              >
                <span className="text-xl leading-none">×</span>
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-5">
              {/* Search criteria */}
              <form onSubmit={handleSearch}>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <label htmlFor="find-titles" className={LABEL}>
                      Job titles
                    </label>
                    <input
                      id="find-titles"
                      type="text"
                      value={findForm.titles}
                      onChange={(e) => updateFindField('titles', e.target.value)}
                      placeholder="comma separated, e.g. Fleet Manager, Operations Director"
                      className={INPUT}
                    />
                  </div>
                  <div>
                    <label htmlFor="find-industries" className={LABEL}>
                      Industries
                    </label>
                    <input
                      id="find-industries"
                      type="text"
                      value={findForm.industries}
                      onChange={(e) => updateFindField('industries', e.target.value)}
                      placeholder="comma separated, e.g. utilities, telecoms"
                      className={INPUT}
                    />
                  </div>
                  <div>
                    <label htmlFor="find-location" className={LABEL}>
                      Location
                    </label>
                    <input
                      id="find-location"
                      type="text"
                      value={findForm.location}
                      onChange={(e) => updateFindField('location', e.target.value)}
                      placeholder="comma separated, e.g. United Kingdom, United States"
                      className={INPUT}
                    />
                  </div>
                  <div>
                    <label htmlFor="find-size" className={LABEL}>
                      Minimum company size
                    </label>
                    <input
                      id="find-size"
                      type="number"
                      min="0"
                      value={findForm.minCompanySize}
                      onChange={(e) => updateFindField('minCompanySize', e.target.value)}
                      placeholder="e.g. 100"
                      className={INPUT}
                    />
                  </div>
                  <div>
                    <label htmlFor="find-perpage" className={LABEL}>
                      Number of results
                    </label>
                    <select
                      id="find-perpage"
                      value={findForm.perPage}
                      onChange={(e) => updateFindField('perPage', e.target.value)}
                      className={INPUT}
                    >
                      <option value="25">25</option>
                      <option value="50">50</option>
                      <option value="100">100</option>
                    </select>
                  </div>
                </div>

                {searchError && (
                  <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                    {searchError}
                  </p>
                )}

                <div className="mt-4 flex justify-end">
                  <button
                    type="submit"
                    disabled={searching}
                    className="inline-flex items-center rounded-full bg-[#7C3AED] px-6 py-2.5 text-sm font-bold text-white transition hover:bg-[#6D28D9] focus:outline-none focus:ring-2 focus:ring-[#7C3AED]/50 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {searching ? 'Searching…' : 'Search Apollo'}
                  </button>
                </div>
              </form>

              {/* Results preview */}
              {searchResults && (
                <div className="mt-6 border-t border-[#E5E7EB] pt-5">
                  {searchResults.length === 0 ? (
                    <p className="text-sm text-[#6B7280]">
                      No matches found. Try broadening your criteria.
                    </p>
                  ) : (
                    <>
                      <div className="mb-3 flex items-center justify-between">
                        <p className="text-sm text-[#6B7280]">
                          <span className="font-semibold text-[#111827]">
                            {selectedRows.size}
                          </span>{' '}
                          of {searchResults.length} selected
                        </p>
                        <button
                          type="button"
                          onClick={toggleSelectAll}
                          className="text-sm font-semibold text-[#7C3AED] hover:text-[#6D28D9]"
                        >
                          {selectedRows.size === searchResults.length
                            ? 'Deselect all'
                            : 'Select all'}
                        </button>
                      </div>

                      <div className="overflow-x-auto rounded-md border border-[#E5E7EB]">
                        <table className="min-w-full">
                          <thead className="border-b border-[#E5E7EB]">
                            <tr>
                              <th className="w-10 px-3 py-2" />
                              <th className={TH}>Name</th>
                              <th className={TH}>Company</th>
                              <th className={TH}>Title</th>
                              <th className={TH}>Location</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-[#E5E7EB]">
                            {searchResults.map((lead, i) => (
                              <tr
                                key={i}
                                onClick={() => toggleRow(i)}
                                className="cursor-pointer transition hover:bg-[#F3F4F6]"
                              >
                                <td className="px-3 py-2.5">
                                  <input
                                    type="checkbox"
                                    checked={selectedRows.has(i)}
                                    onChange={() => toggleRow(i)}
                                    onClick={(e) => e.stopPropagation()}
                                    aria-label={`Select ${lead.contact_name || lead.company_name || 'lead'}`}
                                    className="h-4 w-4 accent-[#7C3AED]"
                                  />
                                </td>
                                <td className="px-3 py-2.5 text-sm font-medium text-[#111827]">
                                  {lead.contact_name || '—'}
                                </td>
                                <td className="px-3 py-2.5 text-sm text-[#6B7280]">
                                  {lead.company_name || '—'}
                                </td>
                                <td className="px-3 py-2.5 text-sm text-[#6B7280]">
                                  {lead.contact_title || '—'}
                                </td>
                                <td className="px-3 py-2.5 text-sm text-[#6B7280]">
                                  {lead.country || '—'}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>

                      {importError && (
                        <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                          {importError}
                        </p>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex justify-end gap-3 border-t border-[#E5E7EB] px-6 py-4">
              <button
                type="button"
                onClick={closeFindModal}
                disabled={searching || importing}
                className="rounded-full border border-[#E5E7EB] bg-white px-6 py-2.5 text-sm font-bold text-[#111827] transition hover:bg-[#F3F4F6] disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleImport}
                disabled={
                  importing ||
                  !searchResults ||
                  searchResults.length === 0 ||
                  selectedRows.size === 0
                }
                className="inline-flex items-center rounded-full bg-[#7C3AED] px-6 py-2.5 text-sm font-bold text-white transition hover:bg-[#6D28D9] focus:outline-none focus:ring-2 focus:ring-[#7C3AED]/50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {importing
                  ? 'Importing…'
                  : `Import ${selectedRows.size} lead${selectedRows.size === 1 ? '' : 's'}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation dialog */}
      {deleteTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onMouseDown={() => {
            if (!deleting) setDeleteTarget(null)
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-campaign-title"
            className="w-full max-w-md rounded-xl bg-white shadow-2xl"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="border-b border-[#E5E7EB] px-6 py-4">
              <h2
                id="delete-campaign-title"
                className="text-lg font-bold text-[#111827]"
              >
                Delete campaign
              </h2>
            </div>

            <div className="px-6 py-5">
              <p className="text-sm text-[#6B7280]">
                Are you sure you want to delete{' '}
                <span className="font-semibold text-[#111827]">
                  {deleteTarget.name}
                </span>
                ? This permanently removes the campaign and all of its leads,
                scores, emails, and sequences. This cannot be undone.
              </p>

              {deleteError && (
                <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                  {deleteError}
                </p>
              )}

              <div className="mt-6 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setDeleteTarget(null)}
                  disabled={deleting}
                  className="rounded-full border border-[#E5E7EB] bg-white px-6 py-2.5 text-sm font-bold text-[#111827] transition hover:bg-[#F3F4F6] disabled:opacity-60"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={deleting}
                  className="inline-flex items-center rounded-full bg-red-500 px-6 py-2.5 text-sm font-bold text-white transition hover:bg-red-600 focus:outline-none focus:ring-2 focus:ring-red-500/50 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {deleting ? 'Deleting…' : 'Delete campaign'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Delete low scores confirmation dialog */}
      {lowScoresTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onMouseDown={() => {
            if (!deletingLowScores) setLowScoresTarget(null)
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-low-scores-title"
            className="w-full max-w-md rounded-xl bg-white shadow-2xl"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="border-b border-[#E5E7EB] px-6 py-4">
              <h2
                id="delete-low-scores-title"
                className="text-lg font-bold text-[#111827]"
              >
                Delete low-scoring leads
              </h2>
            </div>

            <div className="px-6 py-5">
              <p className="text-sm text-[#6B7280]">
                Permanently delete every lead in{' '}
                <span className="font-semibold text-[#111827]">
                  {lowScoresTarget.name}
                </span>{' '}
                that scored below 50, along with their scores, emails, and
                sequences? Unscored leads are kept. This cannot be undone.
              </p>

              {lowScoresError && (
                <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                  {lowScoresError}
                </p>
              )}

              <div className="mt-6 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setLowScoresTarget(null)}
                  disabled={deletingLowScores}
                  className="rounded-full border border-[#E5E7EB] bg-white px-6 py-2.5 text-sm font-bold text-[#111827] transition hover:bg-[#F3F4F6] disabled:opacity-60"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleDeleteLowScores}
                  disabled={deletingLowScores}
                  className="inline-flex items-center rounded-full bg-red-500 px-6 py-2.5 text-sm font-bold text-white transition hover:bg-red-600 focus:outline-none focus:ring-2 focus:ring-red-500/50 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {deletingLowScores ? 'Deleting…' : 'Delete low scores'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

export default Campaigns

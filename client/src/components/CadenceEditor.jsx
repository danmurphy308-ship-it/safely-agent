import { useEffect, useState } from 'react'
import api from '../api.js'
import { getErrorMessage } from '../ui.jsx'

const INPUT_CLASS =
  'w-full rounded-lg border border-[#E5E7EB] bg-white px-3 py-2.5 text-sm text-[#111827] placeholder-[#9CA3AF] transition focus:border-[#7C3AED] focus:outline-none focus:ring-2 focus:ring-[#7C3AED]/30'
const LABEL_CLASS = 'mb-2 block text-xs font-semibold uppercase tracking-wider text-[#6B7280]'

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// Friendly labels for the handful of timezones this team actually uses;
// anything else in Instantly's enum still selects fine, just shown by its raw value.
const TZ_LABELS = {
  'Atlantic/Canary': 'Atlantic/Canary — UK & Ireland time',
  'America/Chicago': 'America/Chicago — US Central',
}

const VARIABLES = [
  { token: '{{firstName}}', hint: "lead's first name" },
  { token: '{{companyName}}', hint: "lead's company" },
  { token: '{{personalized_body}}', hint: "Claude's drafted email body (step 1 only)" },
  { token: '{{sendingAccountFirstName}}', hint: 'whichever inbox actually sends it' },
]

function emptyStep(delayDays = 2) {
  return { subject: '', body: '', delayDays }
}

/**
 * Renders one side of the sync confirmation diff (steps + schedule + limit).
 * `label` is "Current (live in Instantly)" or "New (this campaign's cadence)".
 */
function DiffSide({ label, steps, schedule, dailyLimit }) {
  return (
    <div className="flex-1 rounded-lg border border-[#E5E7EB] bg-[#FAFAFB] p-3">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-[#9CA3AF]">{label}</p>
      <p className="text-xs text-[#6B7280]">
        {steps.length} step{steps.length === 1 ? '' : 's'} · days{' '}
        {steps.map((s) => s.dayOffset ?? '?').join(', ')}
      </p>
      <p className="mt-1 text-xs text-[#6B7280]">
        {schedule.days
          ? DAY_NAMES.filter((_, i) => schedule.days[i]).join(', ') || 'no days'
          : '—'}{' '}
        {schedule.windowStart}–{schedule.windowEnd} · {schedule.timezone}
      </p>
      <p className="mt-1 text-xs text-[#6B7280]">Daily limit: {dailyLimit ?? '—'}</p>
    </div>
  )
}

/**
 * Cadence tab body for the campaign Edit modal: step timeline, schedule
 * controls, and the Save & Sync-to-Instantly flow (with a mandatory
 * confirmation diff — never syncs silently).
 */
export function CadenceEditor({ campaignId }) {
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [guardrails, setGuardrails] = useState(null)
  const [timezones, setTimezones] = useState([])

  const [steps, setSteps] = useState([])
  const [schedule, setSchedule] = useState(null)
  const [dailyLimit, setDailyLimit] = useState(50)
  const [isDefaultSequence, setIsDefaultSequence] = useState(true)

  const [saving, setSaving] = useState(false)
  const [saveErrors, setSaveErrors] = useState([])
  const [saveWarnings, setSaveWarnings] = useState([])
  const [saved, setSaved] = useState(false)

  const [diff, setDiff] = useState(null) // {hasChanges, sequence, schedule, dailyLimit} while confirming
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffError, setDiffError] = useState(null)
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    api
      .get(`/campaigns/${campaignId}/cadence`)
      .then(({ data }) => {
        if (cancelled) return
        setSteps(data.steps.map(({ subject, body, delayDays }) => ({ subject, body, delayDays })))
        setSchedule({
          days: data.schedule.days,
          windowStart: data.schedule.windowStart,
          windowEnd: data.schedule.windowEnd,
          timezone: data.schedule.timezone,
        })
        setDailyLimit(data.dailyLimit)
        setIsDefaultSequence(data.isDefaultSequence)
        setGuardrails(data.guardrails)
        setTimezones(data.timezones)
      })
      .catch((err) => !cancelled && setLoadError(getErrorMessage(err)))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [campaignId])

  function updateStep(index, field, value) {
    setSteps((prev) => prev.map((s, i) => (i === index ? { ...s, [field]: value } : s)))
    setSaved(false)
  }

  function addStep() {
    if (!guardrails || steps.length >= guardrails.maxSteps) return
    setSteps((prev) => [...prev, emptyStep(guardrails.minDaysBetweenSteps)])
    setSaved(false)
  }

  function removeStep(index) {
    if (steps.length <= 1) return
    setSteps((prev) => prev.filter((_, i) => i !== index))
    setSaved(false)
  }

  function moveStep(index, direction) {
    setSteps((prev) => {
      const next = [...prev]
      const target = index + direction
      if (target < 0 || target >= next.length) return prev
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
    setSaved(false)
  }

  function toggleDay(i) {
    setSchedule((prev) => ({ ...prev, days: prev.days.map((d, idx) => (idx === i ? !d : d)) }))
    setSaved(false)
  }

  function updateSchedule(field, value) {
    setSchedule((prev) => ({ ...prev, [field]: value }))
    setSaved(false)
  }

  async function handleSave() {
    setSaving(true)
    setSaveErrors([])
    setSaveWarnings([])
    setSaved(false)
    try {
      const payload = {
        steps: steps.map((s, i) => ({ ...s, delayDays: i === 0 ? 0 : Number(s.delayDays) || 0 })),
        schedule,
        dailyLimit: Number(dailyLimit),
      }
      const { data } = await api.put(`/campaigns/${campaignId}/cadence`, payload)
      setSteps(data.steps.map(({ subject, body, delayDays }) => ({ subject, body, delayDays })))
      setIsDefaultSequence(data.isDefaultSequence)
      setSaveWarnings(data.warnings || [])
      setSaved(true)
    } catch (err) {
      if (err?.response?.status === 422) {
        setSaveErrors(err.response.data.errors || [])
        setSaveWarnings(err.response.data.warnings || [])
      } else {
        setSaveErrors([getErrorMessage(err)])
      }
    } finally {
      setSaving(false)
    }
  }

  async function handleReviewSync() {
    setDiffError(null)
    setSyncResult(null)
    setDiffLoading(true)
    try {
      const { data } = await api.get(`/campaigns/${campaignId}/cadence/diff`)
      setDiff(data)
    } catch (err) {
      setDiffError(getErrorMessage(err))
    } finally {
      setDiffLoading(false)
    }
  }

  async function handleConfirmSync() {
    setSyncing(true)
    setDiffError(null)
    try {
      await api.post(`/campaigns/${campaignId}/cadence/sync`)
      setSyncResult({ ok: true })
      setDiff(null)
    } catch (err) {
      setDiffError(getErrorMessage(err))
    } finally {
      setSyncing(false)
    }
  }

  if (loading) {
    return <p className="py-8 text-center text-sm text-[#6B7280]">Loading cadence…</p>
  }
  if (loadError) {
    return <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{loadError}</p>
  }

  return (
    <div className="space-y-6">
      {isDefaultSequence && (
        <p className="rounded-lg border border-[#E5E7EB] bg-[#F8F9FA] px-3 py-2 text-xs text-[#6B7280]">
          This campaign is using the default Safely sequence. Editing a step below switches it to
          a custom sequence just for this campaign.
        </p>
      )}

      {/* Variable helper */}
      <div className="rounded-lg border border-[#E5E7EB] bg-[#F8F9FA] px-3 py-2">
        <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-[#9CA3AF]">
          Available variables
        </p>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[#6B7280]">
          {VARIABLES.map((v) => (
            <span key={v.token}>
              <code className="rounded bg-white px-1 py-0.5 font-mono text-[#7C3AED]">
                {v.token}
              </code>{' '}
              — {v.hint}
            </span>
          ))}
        </div>
      </div>

      {/* Step timeline */}
      <div className="space-y-4">
        {steps.map((step, i) => (
          <div key={i} className="rounded-lg border border-[#E5E7EB] p-4">
            <div className="mb-3 flex items-center justify-between">
              <span className="inline-flex items-center gap-2 text-sm font-bold text-[#111827]">
                Step {i + 1}
                <span className="rounded-full bg-[#F5F3FF] px-2 py-0.5 text-xs font-semibold text-[#6D28D9]">
                  Day {i === 0 ? 0 : steps.slice(1, i + 1).reduce((sum, s) => sum + (Number(s.delayDays) || 0), 0)}
                </span>
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => moveStep(i, -1)}
                  disabled={i === 0}
                  className="rounded p-1 text-[#6B7280] hover:bg-[#F3F4F6] disabled:opacity-30"
                  aria-label="Move up"
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => moveStep(i, 1)}
                  disabled={i === steps.length - 1}
                  className="rounded p-1 text-[#6B7280] hover:bg-[#F3F4F6] disabled:opacity-30"
                  aria-label="Move down"
                >
                  ↓
                </button>
                <button
                  type="button"
                  onClick={() => removeStep(i)}
                  disabled={steps.length <= 1}
                  className="rounded p-1 text-red-600 hover:bg-red-50 disabled:opacity-30"
                  aria-label="Remove step"
                >
                  ×
                </button>
              </div>
            </div>

            {i > 0 && (
              <div className="mb-3">
                <label className={LABEL_CLASS}>Days after previous step</label>
                <input
                  type="number"
                  min={guardrails?.minDaysBetweenSteps ?? 2}
                  value={step.delayDays}
                  onChange={(e) => updateStep(i, 'delayDays', e.target.value)}
                  className={`${INPUT_CLASS} w-24`}
                />
              </div>
            )}

            <div className="mb-3">
              <label className={LABEL_CLASS}>Subject</label>
              <input
                type="text"
                value={step.subject}
                onChange={(e) => updateStep(i, 'subject', e.target.value)}
                className={`${INPUT_CLASS} font-mono text-xs`}
              />
            </div>
            <div>
              <label className={LABEL_CLASS}>Body</label>
              <textarea
                value={step.body}
                onChange={(e) => updateStep(i, 'body', e.target.value)}
                rows={5}
                className={`${INPUT_CLASS} font-mono text-xs`}
              />
            </div>
          </div>
        ))}

        <button
          type="button"
          onClick={addStep}
          disabled={!guardrails || steps.length >= guardrails.maxSteps}
          className="w-full rounded-lg border border-dashed border-[#E5E7EB] py-2.5 text-sm font-semibold text-[#7C3AED] transition hover:bg-[#F5F3FF] disabled:cursor-not-allowed disabled:opacity-40"
        >
          + Add step{guardrails && ` (${steps.length}/${guardrails.maxSteps})`}
        </button>
      </div>

      {/* Schedule + limits */}
      {schedule && (
        <div className="rounded-lg border border-[#E5E7EB] p-4">
          <p className="mb-3 text-sm font-bold text-[#111827]">Schedule & limits</p>

          <div className="mb-3">
            <label className={LABEL_CLASS}>Sending days</label>
            <div className="flex gap-1.5">
              {DAY_NAMES.map((name, i) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => toggleDay(i)}
                  className={`h-9 w-11 rounded-md text-xs font-semibold transition ${
                    schedule.days[i]
                      ? 'bg-[#7C3AED] text-white'
                      : 'border border-[#E5E7EB] text-[#6B7280] hover:bg-[#F3F4F6]'
                  }`}
                >
                  {name}
                </button>
              ))}
            </div>
          </div>

          <div className="mb-3 grid grid-cols-2 gap-4">
            <div>
              <label className={LABEL_CLASS}>Window start</label>
              <input
                type="time"
                value={schedule.windowStart}
                onChange={(e) => updateSchedule('windowStart', e.target.value)}
                className={INPUT_CLASS}
              />
            </div>
            <div>
              <label className={LABEL_CLASS}>Window end</label>
              <input
                type="time"
                value={schedule.windowEnd}
                onChange={(e) => updateSchedule('windowEnd', e.target.value)}
                className={INPUT_CLASS}
              />
            </div>
          </div>

          <div className="mb-3">
            <label className={LABEL_CLASS}>Timezone</label>
            <select
              value={schedule.timezone}
              onChange={(e) => updateSchedule('timezone', e.target.value)}
              className={INPUT_CLASS}
            >
              {!timezones.includes(schedule.timezone) && (
                <option value={schedule.timezone}>{schedule.timezone}</option>
              )}
              {timezones.map((tz) => (
                <option key={tz} value={tz}>
                  {TZ_LABELS[tz] || tz}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className={LABEL_CLASS}>Daily sending limit</label>
            <input
              type="number"
              min={1}
              max={guardrails?.maxDailyLimit ?? 50}
              value={dailyLimit}
              onChange={(e) => {
                setDailyLimit(e.target.value)
                setSaved(false)
              }}
              className={`${INPUT_CLASS} w-24`}
            />
            <p className="mt-1 text-xs text-[#9CA3AF]">Max {guardrails?.maxDailyLimit ?? 50}.</p>
          </div>
        </div>
      )}

      {saveErrors.length > 0 && (
        <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          <ul className="list-disc pl-4">
            {saveErrors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}
      {saveWarnings.length > 0 && (
        <div className="rounded-md bg-[#FEF9C3] px-3 py-2 text-sm text-[#854D0E]">
          <ul className="list-disc pl-4">
            {saveWarnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="rounded-full bg-[#7C3AED] px-6 py-2.5 text-sm font-bold text-white transition hover:bg-[#6D28D9] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save cadence'}
        </button>
        <button
          type="button"
          onClick={handleReviewSync}
          disabled={diffLoading}
          className="rounded-full border border-[#E5E7EB] bg-white px-6 py-2.5 text-sm font-bold text-[#111827] transition hover:bg-[#F3F4F6] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {diffLoading ? 'Checking…' : 'Save & Sync to Instantly…'}
        </button>
      </div>

      {syncResult?.ok && (
        <p className="rounded-md bg-[#ECFDF5] px-3 py-2 text-sm text-[#047857]">
          Synced to Instantly.
        </p>
      )}

      {/* Confirmation diff — never syncs without this being shown first. */}
      {diff && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
          onMouseDown={() => !syncing && setDiff(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-2xl rounded-lg bg-white shadow-2xl"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="border-b border-[#E5E7EB] px-6 py-4">
              <h3 className="text-lg font-bold text-[#111827]">Confirm sync to Instantly</h3>
              <p className="mt-1 text-sm text-[#6B7280]">
                {diff.hasChanges
                  ? 'This will overwrite the sequence/schedule/limit currently live in Instantly with the version below.'
                  : 'No differences found — Instantly already matches this cadence.'}
              </p>
            </div>
            <div className="max-h-[60vh] overflow-y-auto px-6 py-4">
              <div className="flex gap-3">
                <DiffSide
                  label="Current (live in Instantly)"
                  steps={diff.sequence.steps.map((s) => s.before).filter(Boolean)}
                  schedule={diff.schedule.before}
                  dailyLimit={diff.dailyLimit.before}
                />
                <DiffSide
                  label="New (this campaign's cadence)"
                  steps={diff.sequence.steps.map((s) => s.after).filter(Boolean)}
                  schedule={diff.schedule.after}
                  dailyLimit={diff.dailyLimit.after}
                />
              </div>
              {diff.sequence.changed && (
                <p className="mt-3 text-xs text-[#6B7280]">
                  {diff.sequence.steps.filter((s) => s.changed).length} step(s) differ.
                </p>
              )}
              {diffError && (
                <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                  {diffError}
                </p>
              )}
            </div>
            <div className="flex justify-end gap-3 border-t border-[#E5E7EB] px-6 py-4">
              <button
                type="button"
                onClick={() => setDiff(null)}
                disabled={syncing}
                className="rounded-full border border-[#E5E7EB] bg-white px-6 py-2.5 text-sm font-bold text-[#111827] transition hover:bg-[#F3F4F6] disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmSync}
                disabled={syncing}
                className="rounded-full bg-[#7C3AED] px-6 py-2.5 text-sm font-bold text-white transition hover:bg-[#6D28D9] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {syncing ? 'Syncing…' : diff.hasChanges ? 'Confirm sync' : 'Sync anyway'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Read-only LinkedIn/Aimfox panel: flow summary + warmup limits, with a
 * "Manage in Aimfox" link. Aimfox's API has no endpoint to edit a flow, so
 * this never offers editing — it says so plainly when there's nothing to show.
 */
export function AimfoxPanel({ campaignId }) {
  const [state, setState] = useState({ loading: true })

  useEffect(() => {
    let cancelled = false
    api
      .get(`/campaigns/${campaignId}/aimfox-summary`)
      .then(({ data }) => !cancelled && setState({ loading: false, data }))
      .catch((err) => !cancelled && setState({ loading: false, error: getErrorMessage(err) }))
    return () => {
      cancelled = true
    }
  }, [campaignId])

  if (state.loading) {
    return <p className="py-8 text-center text-sm text-[#6B7280]">Loading from Aimfox…</p>
  }
  if (state.error) {
    return <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{state.error}</p>
  }
  if (!state.data?.available) {
    return (
      <p className="rounded-lg border border-dashed border-[#E5E7EB] px-4 py-6 text-center text-sm text-[#6B7280]">
        {state.data?.reason === 'AIMFOX_API_KEY is not set'
          ? 'Aimfox is not configured on the server.'
          : state.data?.reason === 'no Aimfox campaign configured'
            ? 'This campaign has no linked Aimfox campaign.'
            : state.data?.reason || 'Not available.'}
      </p>
    )
  }

  const { campaign, flows, limits, manageUrl } = state.data

  return (
    <div className="space-y-4">
      <p className="rounded-lg border border-[#E5E7EB] bg-[#F8F9FA] px-3 py-2 text-xs text-[#6B7280]">
        Read-only — Aimfox's API doesn't support editing a campaign's flow. Use{' '}
        <a href={manageUrl} target="_blank" rel="noreferrer" className="font-semibold text-[#7C3AED] underline">
          Manage in Aimfox
        </a>{' '}
        to make changes.
      </p>

      <div className="rounded-lg border border-[#E5E7EB] p-4">
        <p className="text-sm font-bold text-[#111827]">{campaign.name}</p>
        <p className="mt-1 text-xs text-[#6B7280]">
          {campaign.state} · {campaign.outreachType} · {campaign.targetCount} of{' '}
          {campaign.audienceSize} targeted (
          {Math.round((campaign.completion || 0) * 100)}% complete)
        </p>
      </div>

      <div className="rounded-lg border border-[#E5E7EB] p-4">
        <p className="mb-2 text-sm font-bold text-[#111827]">Flow</p>
        {flows.length === 0 && <p className="text-sm text-[#6B7280]">No flows configured.</p>}
        <ul className="space-y-2">
          {flows.map((flow, i) => (
            <li key={i} className="text-sm text-[#6B7280]">
              <span className="font-semibold text-[#111827]">{flow.name}</span> —{' '}
              {flow.messageCount} message step{flow.messageCount === 1 ? '' : 's'}
              {flow.steps.map((s, j) => (
                <span key={j} className="ml-2 text-xs text-[#9CA3AF]">
                  (+{s.delayHours}h: "{s.preview.slice(0, 60)}
                  {s.preview.length > 60 ? '…' : ''}")
                </span>
              ))}
            </li>
          ))}
        </ul>
      </div>

      <div className="rounded-lg border border-[#E5E7EB] p-4">
        <p className="mb-2 text-sm font-bold text-[#111827]">Warmup & limits</p>
        {limits ? (
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm text-[#6B7280]">
            <span>Connect: {limits.connect}/week</span>
            <span>Message request: {limits.message_request}/week</span>
            <span>Email connect: {limits.email_connect}/week</span>
            <span>InMail: {limits.inmail}/week</span>
            {limits.warmup?.enabled && (
              <span className="col-span-2 mt-1 text-xs text-[#9CA3AF]">
                Warmup active ({limits.warmup.speed}) — connect {limits.warmup.connect}, message{' '}
                {limits.warmup.message_request}, InMail {limits.warmup.inmail}
              </span>
            )}
          </div>
        ) : (
          <p className="text-sm text-[#6B7280]">Not available.</p>
        )}
      </div>
    </div>
  )
}

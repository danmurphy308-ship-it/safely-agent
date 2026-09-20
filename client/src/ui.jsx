// Shared UI primitives and Tailwind class constants used across the pages.
// Design system: dark slate sidebar + light content, card-based surfaces,
// colour used semantically only (green=healthy, amber=attention, red=broken,
// violet=brand accent). Colours are plain hex via Tailwind arbitrary values
// (matching this codebase's existing convention) rather than a
// tailwind.config palette, so every page can keep using bracket syntax.

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

// Dark slate sidebar palette.
export const SLATE = {
  bg: '#0B1120',
  surface: '#161F32',
  border: '#232D45',
  textMuted: '#8B96AC',
  textActive: '#F1F5F9',
}

export const BRAND = '#7C3AED'
export const BRAND_DARK = '#6D28D9'

// Semantic colours: green = healthy, amber = attention, red = broken.
export const SEMANTIC = {
  healthy: '#10B981',
  attention: '#F59E0B',
  broken: '#EF4444',
}

export const CARD =
  'rounded-2xl border border-[#E5E7EB] bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04),0_4px_10px_rgba(16,24,40,0.05)]'

export const BTN_PRIMARY =
  'inline-flex items-center justify-center gap-2 rounded-full bg-[#7C3AED] px-5 py-2 text-sm font-bold text-white shadow-sm shadow-[#7C3AED]/20 transition hover:bg-[#6D28D9] focus:outline-none focus:ring-2 focus:ring-[#7C3AED]/40 disabled:cursor-not-allowed disabled:opacity-50'

export const BTN_SECONDARY =
  'inline-flex items-center justify-center rounded-full border border-[#E5E7EB] bg-white px-5 py-2 text-sm font-bold text-[#111827] transition hover:bg-[#F3F4F6] disabled:cursor-not-allowed disabled:opacity-50'

export const INPUT =
  'w-full rounded-lg border border-[#E5E7EB] bg-white px-3 py-2.5 text-sm text-[#111827] placeholder-[#9CA3AF] transition focus:border-[#7C3AED] focus:outline-none focus:ring-2 focus:ring-[#7C3AED]/30'

export const LABEL =
  'mb-2 block text-xs font-semibold uppercase tracking-wider text-[#6B7280]'

export const TH =
  'px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-[#6B7280]'

export const TH_NUM =
  'px-5 py-3 text-right text-xs font-semibold uppercase tracking-wider text-[#6B7280]'

// ---------------------------------------------------------------------------
// Status pills
// ---------------------------------------------------------------------------

const TONES = {
  green: { bg: 'bg-[#ECFDF5]', text: 'text-[#047857]', dot: 'bg-[#10B981]' },
  grey: { bg: 'bg-[#F3F4F6]', text: 'text-[#6B7280]', dot: 'bg-[#9CA3AF]' },
  yellow: { bg: 'bg-[#FFFBEB]', text: 'text-[#92400E]', dot: 'bg-[#F59E0B]' },
  red: { bg: 'bg-[#FEF2F2]', text: 'text-[#B91C1C]', dot: 'bg-[#EF4444]' },
  blue: { bg: 'bg-[#EFF6FF]', text: 'text-[#1D4ED8]', dot: 'bg-[#3B82F6]' },
  purple: { bg: 'bg-[#F5F3FF]', text: 'text-[#6D28D9]', dot: 'bg-[#7C3AED]' },
}

// A status pill: coloured dot + label, semantic tone. `dot={false}` renders
// a plain tinted pill for non-status labels (e.g. counts, tags).
export function Badge({ tone = 'grey', children, dot = true }) {
  const t = TONES[tone] || TONES.grey
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1 text-xs font-semibold capitalize ${t.bg} ${t.text}`}
    >
      {dot && <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${t.dot}`} aria-hidden="true" />}
      {children}
    </span>
  )
}

// Reply-assist category → badge tone + label. Shared by the Replies page and
// the Dashboard's "needs attention" list so a category reads the same badge
// everywhere.
export const CATEGORY_BADGE = {
  interested: { tone: 'green', label: 'Interested' },
  send_info: { tone: 'purple', label: 'Send info' },
  pricing: { tone: 'blue', label: 'Pricing' },
  wrong_person: { tone: 'yellow', label: 'Wrong person' },
  not_interested: { tone: 'grey', label: 'Not interested' },
  auto_reply: { tone: 'grey', label: 'Auto-reply' },
}

// ---------------------------------------------------------------------------
// Avatars
// ---------------------------------------------------------------------------

const AVATAR_PALETTE = [
  { bg: 'bg-[#EDE9FE]', text: 'text-[#6D28D9]' }, // violet
  { bg: 'bg-[#DBEAFE]', text: 'text-[#1D4ED8]' }, // blue
  { bg: 'bg-[#D1FAE5]', text: 'text-[#047857]' }, // green
  { bg: 'bg-[#FEF3C7]', text: 'text-[#92400E]' }, // amber
  { bg: 'bg-[#FCE7F3]', text: 'text-[#9D174D]' }, // pink
  { bg: 'bg-[#E0E7FF]', text: 'text-[#3730A3]' }, // indigo
  { bg: 'bg-[#CCFBF1]', text: 'text-[#0F766E]' }, // teal
]

function hashString(str) {
  let hash = 0
  for (let i = 0; i < str.length; i += 1) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0
  }
  return hash
}

function initials(name) {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

const AVATAR_SIZE = {
  sm: 'h-7 w-7 text-[11px]',
  md: 'h-9 w-9 text-xs',
  lg: 'h-11 w-11 text-sm',
}

// Deterministic initials avatar for a company or contact name — same name
// always resolves to the same colour, so a company reads consistently
// across the Leads/Campaigns/Replies tables.
export function Avatar({ name, size = 'md', className = '' }) {
  const label = (name || '?').toString()
  const palette = AVATAR_PALETTE[hashString(label) % AVATAR_PALETTE.length]
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-bold ${palette.bg} ${palette.text} ${AVATAR_SIZE[size] || AVATAR_SIZE.md} ${className}`}
      aria-hidden="true"
      title={name || undefined}
    >
      {initials(label)}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Sparkline
// ---------------------------------------------------------------------------

// Minimal inline trend line — no charting dependency. `data` is an array of
// numbers, oldest first. Renders flat if there's fewer than 2 points or all
// values are equal.
export function Sparkline({ data = [], width = 64, height = 22, color = '#7C3AED' }) {
  const values = data.filter((v) => typeof v === 'number' && !Number.isNaN(v))
  if (values.length < 2) {
    return <svg width={width} height={height} aria-hidden="true" />
  }
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const stepX = width / (values.length - 1)
  const points = values
    .map((v, i) => {
      const x = i * stepX
      const y = height - ((v - min) / range) * (height - 4) - 2
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  const last = values[values.length - 1]
  const lastX = (values.length - 1) * stepX
  const lastY = height - ((last - min) / range) * (height - 4) - 2

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={lastX} cy={lastY} r="2" fill={color} />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Skeleton loading states
// ---------------------------------------------------------------------------

export function SkeletonLine({ width = 'w-full', className = '' }) {
  return <div className={`h-3 animate-pulse rounded bg-[#E5E7EB] ${width} ${className}`} />
}

export function SkeletonBlock({ className = '' }) {
  return <div className={`animate-pulse rounded-lg bg-[#E5E7EB] ${className}`} />
}

// A skeleton standing in for a data table while it loads: a card with a
// header bar and N shimmering rows.
export function SkeletonTable({ rows = 5, cols = 4 }) {
  return (
    <div className={`overflow-hidden ${CARD}`}>
      <div className="border-b border-[#E5E7EB] px-5 py-3">
        <SkeletonLine width="w-40" />
      </div>
      <div className="divide-y divide-[#E5E7EB]">
        {Array.from({ length: rows }).map((_, r) => (
          <div key={r} className="flex items-center gap-6 px-5 py-4">
            {Array.from({ length: cols }).map((__, c) => (
              <SkeletonLine key={c} width={c === 0 ? 'w-40' : 'w-20'} />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

// A row of skeleton stat cards, for dashboards/funnels while loading.
export function SkeletonStatRow({ count = 4 }) {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className={`${CARD} p-5`}>
          <SkeletonLine width="w-16" className="mb-3" />
          <SkeletonBlock className="h-7 w-20" />
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Stat display
// ---------------------------------------------------------------------------

// Big tabular-numeral stat with a label, optional trend sparkline and delta.
export function StatCard({ label, value, sparkline, delta, deltaTone = 'grey', className = '' }) {
  return (
    <div className={`${CARD} p-5 ${className}`}>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-[#6B7280]">
          {label}
        </span>
        {sparkline && <Sparkline data={sparkline} />}
      </div>
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-3xl font-bold tabular-nums text-[#111827]">{value}</span>
        {delta != null && delta !== '' && (
          <span className={TONES[deltaTone]?.text || TONES.grey.text + ' text-xs font-semibold'}>
            {delta}
          </span>
        )}
      </div>
    </div>
  )
}

export function Spinner({ label }) {
  return (
    <div className={`flex items-center justify-center ${CARD} py-16 text-sm text-[#6B7280]`}>
      <span className="mr-3 h-4 w-4 animate-spin rounded-full border-2 border-[#E5E7EB] border-t-[#7C3AED]" />
      {label}
    </div>
  )
}

export function ErrorBanner({ message, onRetry }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
      <span>{message}</span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="rounded-full border border-red-300 px-4 py-1.5 font-semibold text-red-700 transition hover:bg-red-100"
        >
          Retry
        </button>
      )}
    </div>
  )
}

export function getErrorMessage(err) {
  return (
    err?.response?.data?.error ||
    err?.message ||
    'Something went wrong. Please try again.'
  )
}

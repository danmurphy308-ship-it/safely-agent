import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import Campaigns from './pages/Campaigns.jsx'
import Leads from './pages/Leads.jsx'
import CallList from './pages/CallList.jsx'
import Emails from './pages/Emails.jsx'
import Replies from './pages/Replies.jsx'
import Dashboard from './pages/Dashboard.jsx'
import Funnel from './pages/Funnel.jsx'
import Settings from './pages/Settings.jsx'
import Login from './pages/Login.jsx'
import ChatWidget from './components/ChatWidget.jsx'
import { useAuth } from './auth.jsx'

// Stroke-based icon set (Feather-style, hand-authored — no icon library
// dependency), one per nav item, replacing the earlier emoji icons.
const ICONS = {
  dashboard: (
    <path d="M3 13h4V3H3v10zm0 8h4v-6H3v6zm7 0h4V11h-4v10zm0-18v6h4V3h-4zm7 18h4v-8h-4v8zm0-18v6h4V3h-4z" />
  ),
  funnel: <path d="M4 4h16l-6 8v6l-4 2v-8L4 4z" />,
  campaigns: (
    <path d="M3 11v2a1 1 0 0 0 1 1h1l3 6h2l-1-6h4l7 4V6l-7 4H8L5 4H4a1 1 0 0 0-1 1v6z" />
  ),
  leads: (
    <path d="M9 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-7 8a7 7 0 0 1 14 0H2zm14-8a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zm.5 1c-.53 0-1.03.07-1.5.2A6.98 6.98 0 0 1 18 20h4a5.5 5.5 0 0 0-4.5-6z" />
  ),
  outreach: (
    <path d="M3 6h18v12H3V6zm0 0l9 7 9-7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  ),
  callList: (
    <path
      d="M6.6 10.8c1.3 2.6 3.4 4.7 6 6l2-2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.5.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.9c.6 0 1 .4 1 1 0 1.2.2 2.4.6 3.5.1.4 0 .8-.2 1.1l-2 2.2z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  replies: (
    <path d="M4 4h16v11H8l-4 4V4z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  ),
  settings: (
    <path
      d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm7.4-3a7.4 7.4 0 0 1-.1 1.2l2 1.6-2 3.4-2.4-1a7.6 7.6 0 0 1-2 1.2l-.4 2.6H9.5l-.4-2.6a7.6 7.6 0 0 1-2-1.2l-2.4 1-2-3.4 2-1.6a7.4 7.4 0 0 1 0-2.4l-2-1.6 2-3.4 2.4 1a7.6 7.6 0 0 1 2-1.2l.4-2.6h5l.4 2.6a7.6 7.6 0 0 1 2 1.2l2.4-1 2 3.4-2 1.6c.07.4.1.8.1 1.2z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
    />
  ),
}

function NavIcon({ name }) {
  return (
    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="currentColor" aria-hidden="true">
      {ICONS[name]}
    </svg>
  )
}

const NAV_ITEMS = [
  { to: '/dashboard', label: 'Dashboard', icon: 'dashboard' },
  { to: '/funnel', label: 'Funnel', icon: 'funnel' },
  { to: '/campaigns', label: 'Campaigns', icon: 'campaigns' },
  { to: '/leads', label: 'Leads', icon: 'leads' },
  { to: '/call-list', label: 'Call List', icon: 'callList' },
  { to: '/emails', label: 'Outreach', icon: 'outreach' },
  { to: '/replies', label: 'Replies', icon: 'replies' },
  { to: '/settings', label: 'Settings', icon: 'settings' },
]

function App() {
  const { user, loading } = useAuth()

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#F8F9FB]">
        <span className="h-6 w-6 animate-spin rounded-full border-2 border-[#E5E7EB] border-t-[#7C3AED]" />
      </div>
    )
  }

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/dashboard" replace /> : <Login />} />
      <Route path="/*" element={user ? <AuthedShell user={user} /> : <Navigate to="/login" replace />} />
    </Routes>
  )
}

function AuthedShell({ user }) {
  const { logout } = useAuth()

  return (
    <div className="flex min-h-screen bg-[#F8F9FB]">
      <aside className="flex w-60 shrink-0 flex-col bg-[#0B1120] px-3 py-6">
        <div className="mb-8 flex items-center gap-2.5 px-3">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#7C3AED] text-sm font-bold text-white shadow-[0_0_0_1px_rgba(124,58,237,0.4),0_0_16px_rgba(124,58,237,0.5)]">
            S
          </span>
          <span className="text-[17px] font-bold tracking-tight text-white">Safely</span>
        </div>

        <nav className="flex flex-col gap-1">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition ${
                  isActive
                    ? 'bg-[#7C3AED]/15 text-white'
                    : 'text-[#8B96AC] hover:bg-white/5 hover:text-[#F1F5F9]'
                }`
              }
            >
              {({ isActive }) => (
                <>
                  <span className={isActive ? 'text-[#A78BFA]' : 'text-[#5B6478]'}>
                    <NavIcon name={item.icon} />
                  </span>
                  {item.label}
                </>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="mt-auto flex items-center justify-between gap-2 border-t border-white/5 px-3 pt-4">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-[#F1F5F9]">{user.name}</p>
            <p className="truncate text-[11px] text-[#5B6478]">{user.email}</p>
          </div>
          <button
            type="button"
            onClick={logout}
            className="shrink-0 rounded-lg px-2 py-1 text-[11px] font-semibold text-[#8B96AC] transition hover:bg-white/5 hover:text-[#F1F5F9]"
          >
            Log out
          </button>
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto px-10 py-8">
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/funnel" element={<Funnel />} />
          <Route path="/campaigns" element={<Campaigns />} />
          <Route path="/leads" element={<Leads />} />
          <Route path="/call-list" element={<CallList />} />
          <Route path="/emails" element={<Emails />} />
          <Route path="/replies" element={<Replies />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>

      <ChatWidget />
    </div>
  )
}

function NotFound() {
  return (
    <section>
      <h1 className="text-2xl font-bold text-[#111827]">Page not found</h1>
      <p className="mt-1 text-sm text-[#6B7280]">The page you're looking for doesn't exist.</p>
    </section>
  )
}

export default App

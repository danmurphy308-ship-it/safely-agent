import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../auth.jsx'
import { BTN_PRIMARY, CARD, INPUT, LABEL, getErrorMessage } from '../ui.jsx'

function Login() {
  const { login } = useAuth()
  const navigate = useNavigate()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await login(email, password)
      navigate('/dashboard', { replace: true })
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#F8F9FB] px-4">
      <div className={`w-full max-w-sm p-8 ${CARD}`}>
        <div className="mb-8 flex items-center justify-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#7C3AED] text-base font-bold text-white shadow-[0_0_0_1px_rgba(124,58,237,0.4),0_0_16px_rgba(124,58,237,0.5)]">
            S
          </span>
          <span className="text-xl font-bold tracking-tight text-[#111827]">Safely</span>
        </div>

        <h1 className="mb-1 text-center text-lg font-bold text-[#111827]">Sign in</h1>
        <p className="mb-6 text-center text-sm text-[#6B7280]">AI SDR &middot; Transpoco</p>

        {error && (
          <p className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
            {error}
          </p>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="email" className={LABEL}>
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@transpoco.com"
              className={INPUT}
            />
          </div>
          <div>
            <label htmlFor="password" className={LABEL}>
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className={INPUT}
            />
          </div>
          <button type="submit" disabled={submitting} className={`${BTN_PRIMARY} w-full`}>
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}

export default Login

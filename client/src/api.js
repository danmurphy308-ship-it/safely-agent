import axios from 'axios'

// Calls the backend Express API. In dev, Vite proxies /api to the backend
// (see vite.config.js); in production set VITE_API_BASE_URL to the API origin.
const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || '/api',
})

// Session expiry mid-use: any call other than the auth ones itself getting a
// 401 means the cookie expired or was revoked since the app loaded — send the
// user back to /login. /auth/me and /auth/login handle their own 401s locally
// (AuthProvider's initial check, the login form's error message).
api.interceptors.response.use(
  (res) => res,
  (err) => {
    const url = err.config?.url || ''
    if (err.response?.status === 401 && !url.includes('/auth/')) {
      window.location.href = '/login'
    }
    return Promise.reject(err)
  }
)

export default api

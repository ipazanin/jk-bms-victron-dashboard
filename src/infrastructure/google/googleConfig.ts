export function googleConfig() {
  if (import.meta.env.VITE_FAKE_BLE === 'true') return null
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID?.trim()
  const apiKey = import.meta.env.VITE_GOOGLE_API_KEY?.trim()
  const projectNumber = import.meta.env.VITE_GOOGLE_PROJECT_NUMBER?.trim()
  if (!clientId || !apiKey || !projectNumber) return null
  return { clientId, apiKey, projectNumber }
}

import { buildWebSocketUrl, getActiveProfileName, getApiKey, request } from '../client'

export interface FnosBrowserState {
  ready: boolean
  url: string
  streamPort: number
}

function profileBody(): { profile?: string } {
  const profile = getActiveProfileName()
  return profile ? { profile } : {}
}

export function getFnosBrowserState(): Promise<FnosBrowserState> {
  return request<FnosBrowserState>('/api/hermes/browser/state')
}

export function navigateFnosBrowser(url: string): Promise<{ url: string }> {
  return request<{ url: string }>('/api/hermes/browser/navigate', {
    method: 'POST',
    body: JSON.stringify({ ...profileBody(), url }),
  })
}

export function browserAction(action: 'back' | 'forward' | 'reload'): Promise<{ url: string }> {
  return request<{ url: string }>('/api/hermes/browser/action', {
    method: 'POST',
    body: JSON.stringify({ ...profileBody(), action }),
  })
}

export function closeFnosBrowser(): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>('/api/hermes/browser/close', {
    method: 'POST',
    body: JSON.stringify(profileBody()),
  })
}

export function fnosBrowserStreamUrl(): string {
  const profile = getActiveProfileName()
  const url = new URL(buildWebSocketUrl('/api/hermes/browser/stream'))
  url.searchParams.set('token', getApiKey())
  if (profile) url.searchParams.set('profile', profile)
  return url.toString()
}

import { request } from '../client'
import type {
  DesktopBrowserDownload,
  DesktopBrowserProfile,
  DesktopBrowserState,
} from '@/utils/desktop-bridge'

export type FnosBrowserState = Omit<DesktopBrowserState, 'available' | 'visible' | 'maxTabs'> & {
  available: true
  visible: false
  maxTabs: 0
}

export type FnosBrowserProfile = DesktopBrowserProfile

export function getFnosBrowserConfig(): Promise<FnosBrowserState> {
  return request<FnosBrowserState>('/api/hermes/browser/config')
}

export function createFnosBrowserProfile(input: {
  name: string
  rootDirectory: string
  proxyMode?: 'direct' | 'system' | 'fixed_servers'
  proxyRules?: string
}): Promise<FnosBrowserProfile> {
  return request<FnosBrowserProfile>('/api/hermes/browser/config/profiles', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function updateFnosBrowserProfile(profileId: string, input: {
  name?: string
  rootDirectory?: string
  proxyMode?: 'direct' | 'system' | 'fixed_servers'
  proxyRules?: string
  askBeforeDownload?: boolean
  downloadConflictPolicy?: 'ask' | 'uniquify'
}): Promise<FnosBrowserProfile> {
  return request<FnosBrowserProfile>(`/api/hermes/browser/config/profiles/${encodeURIComponent(profileId)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  })
}

export function activateFnosBrowserProfile(profileId: string): Promise<FnosBrowserState> {
  return request<FnosBrowserState>('/api/hermes/browser/config/active', {
    method: 'POST',
    body: JSON.stringify({ profileId }),
  })
}

export function deleteFnosBrowserProfile(profileId: string): Promise<FnosBrowserState> {
  return request<FnosBrowserState>(`/api/hermes/browser/config/profiles/${encodeURIComponent(profileId)}`, {
    method: 'DELETE',
  })
}

export function clearFnosBrowserProfileData(profileId: string, kind: 'cache' | 'site-data' | 'permission-audit'): Promise<FnosBrowserState> {
  return request<FnosBrowserState>(`/api/hermes/browser/config/profiles/${encodeURIComponent(profileId)}/clear`, {
    method: 'POST',
    body: JSON.stringify({ kind }),
  })
}

export type FnosBrowserDownload = DesktopBrowserDownload

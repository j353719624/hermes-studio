import { config } from '../../config'
import { getLanEndpointKind } from '../lan-discovery'
import { getDeviceIdentity, getPublicSystemInfo } from '../system-info'
import {
  getAppRelayClient,
  startAppRelayClient,
  stopAppRelayClient,
  type AppRelayClient,
} from './client'

export const APP_RELAY_CONNECTION_ID = 'app-relay'

export async function ensureAppRelayHostClient(): Promise<AppRelayClient | null> {
  const existing = getAppRelayClient(APP_RELAY_CONNECTION_ID)
  if (existing && !existing.isPreconnectionExpired()) return existing
  if (existing) stopAppRelayHostClient()
  const [identity, info] = await Promise.all([getDeviceIdentity(), getPublicSystemInfo()])
  const localEndpoint = getLocalRelayEndpoint()
  return startAppRelayClient({
    connectionId: APP_RELAY_CONNECTION_ID,
    relayUrl: config.appRelay.url,
    machineId: identity.device_id,
    publicKey: identity.device_public_key,
    machineInfo: {
      ...info,
      http_port: localEndpoint.port,
      endpoint_kind: getLanEndpointKind(localEndpoint.port),
    },
    localBaseUrl: localEndpoint.baseUrl,
  })
}

function getLocalRelayEndpoint(): { baseUrl: string; port: number } {
  const fallback = {
    baseUrl: `http://127.0.0.1:${config.port}`,
    port: config.port,
  }
  const configured = process.env.HERMES_WEB_UI_URL?.trim()
  if (!configured) return fallback
  try {
    const url = new URL(configured)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return fallback
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) return fallback
    return { baseUrl: configured.replace(/\/$/, ''), port }
  } catch {
    return fallback
  }
}

export function stopAppRelayHostClient(): void {
  stopAppRelayClient(APP_RELAY_CONNECTION_ID)
}

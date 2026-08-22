import { join, resolve } from 'path'
import { homedir } from 'os'

/**
 * Web UI environment variables.
 *
 * Server/listen:
 * - PORT: Web UI listen port. Default: 8648.
 * - BIND_HOST: Web UI bind host. Default: 0.0.0.0.
 * - HERMES_WEB_UI_SOCKET: Unix Socket used by the fnOS unified gateway.
 * - HERMES_WEB_UI_SOCKET_MODE: Unix Socket mode. Default: 0660.
 * - HERMES_LAN_PORT: Optional LAN peer listener port. `0` selects an available port.
 * - HERMES_LAN_HOST: LAN peer listener bind host. Default: 0.0.0.0.
 * - HERMES_WEB_UI_BASE_PATH: Public reverse-proxy prefix, for example /app/hermes-studio.
 * - HERMES_FNOS_MODE: Enable fnOS gateway identity checks and the restricted feature set.
 * - CORS_ORIGINS: Comma/space-separated cross-origin allowlist. Default: same host only.
 *
 * Web UI storage:
 * - HERMES_WEB_UI_HOME: Web UI data home for auth token, credentials, logs, DB, and default uploads.
 * - HERMES_WEBUI_STATE_DIR: Compatibility alias for HERMES_WEB_UI_HOME.
 *   Default: join(homedir(), '.hermes-web-ui').
 * - UPLOAD_DIR: Upload directory override. Default: join(HERMES_WEB_UI_HOME, 'upload').
 * - dataDir: Development-only internal Web UI runtime data directory.
 *
 * Auth:
 * - AUTH_TOKEN: Explicit bearer token. If unset, Web UI stores an auto-generated token under HERMES_WEB_UI_HOME.
 * - HERMES_WEB_UI_AUTH_JWT_EXPIRES_IN: Username/password session JWT lifetime. Supports seconds or s/m/h/d suffixes. Default: 30d.
 *
 * Runtime behavior:
 * - PROFILE: Initial Hermes profile name. Default: default.
 * - HERMES_GATEWAY_URL / GATEWAY_URL: Explicit Hermes gateway upstream URL for proxy routes.
 * - GATEWAY_HOST: Default Hermes gateway upstream host. Default: 127.0.0.1.
 * - GATEWAY_PORT: Default Hermes gateway upstream port. Default: 8642.
 * - HERMES_GATEWAY_API_KEY / API_SERVER_KEY: Optional Gateway API bearer key override.
 * - HERMES_WEB_UI_DISABLE_GATEWAY_AUTOSTART: Disable Web UI gateway autostart checks and config-driven gateway start/stop reconciliation.
 * - HERMES_WEB_UI_MANAGED_GATEWAY: Web UI-managed Hermes gateway handling. Enabled by default; set 0/false/off to use CLI start.
 * - HERMES_WEB_UI_STOP_GATEWAYS_ON_SHUTDOWN: Whether Web UI shutdown also stops managed gateways.
 * - HERMES_WEB_UI_DISABLE_MCP_AUTOINJECT: Disable Hermes Studio MCP config injection.
 * - HERMES_WEB_UI_ALLOW_TRANSIENT_MCP_AUTOINJECT: Allow MCP injection when HERMES_WEB_UI_HOME is under a temp dir.
 * - HERMES_LAN_DISCOVERY_ENABLED: Set false/0/off to disable UDP LAN discovery responder.
 * - HERMES_LAN_DISCOVERY_HTTP_PORTS: HTTP ports to probe during UDP discovery scans. Default: 8648,8748 plus current PORT.
 *   Discovery probes are sent to the fixed UDP port 48640 plus legacy mapped ports for compatibility.
 * - HERMES_LAN_ADVERTISE_URL: Publicly reachable Studio origin used in LAN QR codes, especially from Docker.
 * - HERMES_APP_ENTITLEMENT_REQUIRED: Require an RS256 cloud entitlement for App LAN relay connections.
 * - HERMES_APP_ENTITLEMENT_PUBLIC_KEY: Optional PEM public-key override for App entitlement verification.
 * - WORKSPACE_BASE: Base directory for workspace browsing. Default: current user's home directory.
 *
 * Limits/logging:
 * - MAX_DOWNLOAD_SIZE: Max file download size. Default: 200MB.
 * - MAX_EDIT_SIZE: Max editable file size. Default: 10MB.
 * - LOG_LEVEL: Server log level. Default: info.
 * - BRIDGE_LOG_LEVEL: Bridge log level. Default: LOG_LEVEL or info.
 */

export function getListenHost(env: Record<string, string | undefined> = process.env): string {
  const host = env.BIND_HOST?.trim()
  return host || '0.0.0.0'
}

function enabledFlag(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase())
}

export function isFnosMode(env: Record<string, string | undefined> = process.env): boolean {
  return enabledFlag(env.HERMES_FNOS_MODE)
}

export function getPublicBasePath(env: Record<string, string | undefined> = process.env): string {
  const raw = env.HERMES_WEB_UI_BASE_PATH?.trim() || ''
  if (!raw || raw === '/') return ''
  if (raw.includes('\0') || raw.includes('?') || raw.includes('#')) {
    throw new Error('HERMES_WEB_UI_BASE_PATH must be a URL pathname')
  }

  const normalized = `/${raw.replace(/^\/+|\/+$/g, '')}`
  const segments = normalized.split('/').filter(Boolean)
  if (segments.some(segment => segment === '.' || segment === '..')) {
    throw new Error('HERMES_WEB_UI_BASE_PATH cannot contain dot segments')
  }
  return normalized
}

export function stripPublicBasePath(path: string, basePath = getPublicBasePath()): string {
  if (!basePath) return path
  if (path === basePath || path === `${basePath}/`) return '/'
  if (path.startsWith(`${basePath}/`)) return path.slice(basePath.length) || '/'
  return path
}

export function getSocketIoPath(env: Record<string, string | undefined> = process.env): string {
  return `${getPublicBasePath(env)}/socket.io` || '/socket.io'
}

export function getUnixSocketPath(env: Record<string, string | undefined> = process.env): string {
  const value = env.HERMES_WEB_UI_SOCKET?.trim()
  return value ? resolve(value) : ''
}

export function getUnixSocketMode(env: Record<string, string | undefined> = process.env): number {
  const raw = env.HERMES_WEB_UI_SOCKET_MODE?.trim() || '0660'
  if (!/^[0-7]{3,4}$/.test(raw)) {
    throw new Error('HERMES_WEB_UI_SOCKET_MODE must be an octal file mode')
  }
  const mode = Number.parseInt(raw, 8)
  if (mode < 0o600 || mode > 0o777) {
    throw new Error('HERMES_WEB_UI_SOCKET_MODE must be between 0600 and 0777')
  }
  return mode
}

export function getLanListenPort(env: Record<string, string | undefined> = process.env): number | undefined {
  const raw = env.HERMES_LAN_PORT?.trim()
  if (raw === undefined || raw === '') return undefined
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error('HERMES_LAN_PORT must be an integer between 0 and 65535')
  }
  return value
}

export function getLanListenHost(env: Record<string, string | undefined> = process.env): string {
  return env.HERMES_LAN_HOST?.trim() || '0.0.0.0'
}

export function getWebUiHome(env: Record<string, string | undefined> = process.env): string {
  const appHome = env.HERMES_WEB_UI_HOME?.trim() || env.HERMES_WEBUI_STATE_DIR?.trim()
  return appHome ? resolve(appHome) : join(homedir(), '.hermes-web-ui')
}

export function shouldCreateWebUiDataDir(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV !== 'production'
}

export function getCorsOrigins(env: Record<string, string | undefined> = process.env): string {
  return env.CORS_ORIGINS?.trim() || ''
}

export function getLanAdvertiseUrl(env: Record<string, string | undefined> = process.env): string {
  const value = env.HERMES_LAN_ADVERTISE_URL?.trim()
  if (!value) return ''
  try {
    const url = new URL(value.includes('://') ? value : `http://${value}`)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    if (!url.hostname || url.username || url.password) return ''
    return url.origin
  } catch {
    return ''
  }
}

export function isAppEntitlementRequired(env: Record<string, string | undefined> = process.env): boolean {
  const value = String(env.HERMES_APP_ENTITLEMENT_REQUIRED || '').trim().toLowerCase()
  return !['0', 'false', 'no', 'off'].includes(value)
}

const appHome = getWebUiHome()
const publicBasePath = getPublicBasePath()
const remoteRelay = {
  url: process.env.HERMES_REMOTE_RELAY_URL?.trim() || 'https://api.hermes-studio.ai',
}
const appRelay = {
  url: process.env.HERMES_APP_RELAY_URL?.trim() || 'https://api.hermes-studio.ai',
  entitlementRequired: isAppEntitlementRequired(),
}

export const config = {
  port: parseInt(process.env.PORT || '8648', 10),
  // Default to IPv4 for stable WSL/Windows browser access. Use BIND_HOST=:: explicitly for IPv6.
  host: getListenHost(),
  fnos: isFnosMode(),
  publicBasePath,
  socketIoPath: getSocketIoPath(),
  unixSocketPath: getUnixSocketPath(),
  unixSocketMode: getUnixSocketMode(),
  lanPort: getLanListenPort(),
  lanHost: getLanListenHost(),
  appHome,
  uploadDir: process.env.UPLOAD_DIR || join(appHome, 'upload'),
  dataDir: resolve(__dirname, '..', 'data'),
  corsOrigins: getCorsOrigins(),
  lanAdvertiseUrl: getLanAdvertiseUrl(),
  remoteRelay,
  appRelay,
}

export function getLanHttpPort(env: Record<string, string | undefined> = process.env): number {
  const raw = env.HERMES_LAN_HTTP_PORT?.trim()
  const value = Number(raw)
  if (raw && Number.isInteger(value) && value > 0 && value <= 65535) return value
  return config.port
}

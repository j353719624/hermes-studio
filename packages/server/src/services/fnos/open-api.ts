import { request } from 'node:http'
import { randomUUID } from 'node:crypto'

const FNOS_OPEN_GATEWAY_SOCKET = '/var/run/trim_open_gateway_apiscope.socket'
const FNOS_OPEN_GATEWAY_PATH = '/api/v1/trimapp'
const APP_NAME = 'hermes-studio'

interface FnosOpenApiResponse<T> {
  code?: number | string
  msg?: string
  data?: T
}

interface SharedFoldersResponse {
  paths?: unknown
}

export interface FnosPlatformConfig {
  systemVersion?: unknown
  systemLanguage?: unknown
  appVersion?: unknown
  [key: string]: unknown
}

function isFnosMode(): boolean {
  return process.env.HERMES_FNOS_MODE === '1'
}

/**
 * Call the fnOS app-scope gateway over its local Unix socket.
 * Tokens and response bodies are intentionally never logged.
 */
async function callFnosOpenApi<T>(req: string, data: Record<string, unknown> = {}): Promise<T | null> {
  if (!isFnosMode()) return null

  const token = process.env.TRIM_API_TOKEN?.trim()
  if (!token) return null

  const body = JSON.stringify({
    reqId: randomUUID(),
    req,
    appName: APP_NAME,
    data,
  })

  return await new Promise<T | null>((resolve, reject) => {
    const client = request({
      socketPath: FNOS_OPEN_GATEWAY_SOCKET,
      path: FNOS_OPEN_GATEWAY_PATH,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 3000,
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        if ((response.statusCode || 0) < 200 || (response.statusCode || 0) >= 300) {
          resolve(null)
          return
        }
        try {
          const parsed = JSON.parse(raw) as FnosOpenApiResponse<T>
          if (parsed.code !== undefined && parsed.code !== 0 && parsed.code !== '0') {
            resolve(null)
            return
          }
          resolve(parsed.data ?? null)
        } catch {
          resolve(null)
        }
      })
    })

    client.on('timeout', () => client.destroy(new Error('fnOS Open API timeout')))
    client.on('error', reject)
    client.end(body)
  }).catch(() => null)
}

/**
 * Return shared roots that fnOS has made accessible to this app.
 * An unavailable gateway yields an empty list; the app-owned workspace remains
 * usable, while external paths fail closed during workspace validation.
 */
export async function listFnosSharedAccessibleFolders(): Promise<string[]> {
  const result = await callFnosOpenApi<SharedFoldersResponse>('trim.file.getSharedAccessibleFolders')
  if (!Array.isArray(result?.paths)) return []

  return result.paths
    .filter((value): value is string => typeof value === 'string')
    .map(value => value.trim())
    .filter(value => value.startsWith('/') && !value.includes('\0'))
}

/**
 * Read the documented fnOS platform configuration through the app-scope
 * gateway. This is deliberately kept separate from the legacy appcgi
 * sysinfo endpoints used by trim-cli.
 */
export async function getFnosPlatformConfig(): Promise<FnosPlatformConfig | null> {
  return await callFnosOpenApi<FnosPlatformConfig>('trim.system.getPlatformConfig')
}

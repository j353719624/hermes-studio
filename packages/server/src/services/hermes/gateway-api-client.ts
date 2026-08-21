import { randomBytes } from 'crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getActiveProfileName, getProfileDir } from './hermes-profile'

export interface GatewayRunEvent {
  event: string
  data: Record<string, unknown>
}

export interface GatewayRunStartResponse {
  run_id: string
  session_id?: string
  status?: string
  [key: string]: unknown
}

export interface GatewayRunResponse {
  run_id: string
  session_id?: string
  status?: string
  output?: string
  error?: string
  [key: string]: unknown
}

export interface GatewaySession {
  id: string
  source?: string
  user_id?: string | number | null
  model?: string | null
  title?: string | null
  started_at?: number | string | null
  ended_at?: number | string | null
  end_reason?: string | null
  message_count?: number
  tool_call_count?: number
  input_tokens?: number
  output_tokens?: number
  last_active?: number | string | null
  parent_session_id?: string | null
  pinned?: boolean
  archived?: boolean
  hidden?: boolean
  [key: string]: unknown
}

export interface GatewaySessionMessage {
  id?: string | number
  session_id?: string
  role?: string
  content?: unknown
  tool_call_id?: string | null
  tool_calls?: unknown[]
  tool_name?: string | null
  timestamp?: number | string | null
  token_count?: number | null
  finish_reason?: string | null
  reasoning?: unknown
  reasoning_content?: unknown
  [key: string]: unknown
}

export interface GatewaySessionListResponse {
  object?: string
  data?: GatewaySession[]
  limit?: number
  offset?: number
  has_more?: boolean
  [key: string]: unknown
}

export interface GatewaySessionResponse {
  object?: string
  session?: GatewaySession
  [key: string]: unknown
}

export interface GatewaySessionMessagesResponse {
  object?: string
  session_id?: string
  data?: GatewaySessionMessage[]
  pagination?: Record<string, unknown>
  [key: string]: unknown
}

export class GatewayApiError extends Error {
  readonly status?: number
  readonly code?: string
  readonly response?: unknown

  constructor(message: string, options: { status?: number; code?: string; response?: unknown } = {}) {
    super(message)
    this.name = 'GatewayApiError'
    this.status = options.status
    this.code = options.code
    this.response = options.response
  }
}

function envFlag(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value.trim() === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

function readEnvFileValue(profileDir: string, names: string[]): string | undefined {
  const path = join(profileDir, '.env')
  if (!existsSync(path)) return undefined
  try {
    const content = readFileSync(path, 'utf8')
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
      if (!match || !names.includes(match[1])) continue
      const value = match[2].trim()
      if (!value) continue
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        return value.slice(1, -1)
      }
      return value
    }
  } catch {
    // The Gateway will report a useful auth error if its profile env cannot
    // be read. Keep the client usable with the generated fallback key.
  }
  return undefined
}

const GATEWAY_API_KEY_FILE = '.hermes-studio-gateway-api-key'

export function getOrCreateGatewayApiKey(profileDir = getProfileDir(getActiveProfileName())): string {
  const fromProcess = process.env.HERMES_GATEWAY_API_KEY?.trim() || process.env.API_SERVER_KEY?.trim()
  if (fromProcess && fromProcess.length >= 16) return fromProcess

  const fromProfileEnv = readEnvFileValue(profileDir, ['HERMES_GATEWAY_API_KEY', 'API_SERVER_KEY'])
  if (fromProfileEnv && fromProfileEnv.length >= 16) return fromProfileEnv

  const path = join(profileDir, GATEWAY_API_KEY_FILE)
  try {
    const existing = readFileSync(path, 'utf8').trim()
    if (existing.length >= 16) return existing
  } catch {
    // Create the key below.
  }

  const key = randomBytes(32).toString('hex')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(path, `${key}\n`, { encoding: 'utf8', mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {
    // chmod is not available on all supported filesystems (notably Windows).
  }
  return key
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  return trimmed.endsWith('/v1') ? trimmed.slice(0, -3) : trimmed
}

function resolveGatewayBaseUrl(): string {
  const explicit = process.env.HERMES_GATEWAY_API_URL?.trim()
    || process.env.HERMES_GATEWAY_URL?.trim()
    || process.env.GATEWAY_URL?.trim()
  if (explicit) return normalizeBaseUrl(explicit)

  const host = process.env.API_SERVER_HOST?.trim() || process.env.GATEWAY_HOST?.trim() || '127.0.0.1'
  const port = process.env.API_SERVER_PORT?.trim() || process.env.GATEWAY_PORT?.trim() || '8642'
  return `http://${host}:${port}`
}

function profilePrefixEnabled(): boolean {
  return envFlag(process.env.HERMES_GATEWAY_API_PROFILE_PREFIX, true)
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function responseErrorMessage(payload: unknown, fallback: string): string {
  const object = jsonObject(payload)
  const error = object.error
  if (typeof error === 'string' && error.trim()) return error
  if (error && typeof error === 'object' && typeof (error as any).message === 'string') return String((error as any).message)
  if (typeof object.detail === 'string' && object.detail.trim()) return object.detail
  return fallback
}

function networkErrorCode(error: unknown): string {
  return String((error as any)?.code || (error as any)?.cause?.code || '')
}

export class GatewayApiClient {
  readonly baseUrl: string
  readonly profile: string
  readonly apiKey: string
  readonly timeoutMs: number
  private readonly profilePrefix: string

  constructor(options: { profile?: string; baseUrl?: string; apiKey?: string; timeoutMs?: number } = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl || resolveGatewayBaseUrl())
    this.profile = options.profile?.trim() || getActiveProfileName() || 'default'
    this.apiKey = options.apiKey || getOrCreateGatewayApiKey(getProfileDir(this.profile))
    this.timeoutMs = options.timeoutMs ?? 5_000
    this.profilePrefix = profilePrefixEnabled() && this.profile !== 'default'
      ? `/p/${encodeURIComponent(this.profile)}`
      : ''
  }

  private url(path: string): string {
    return `${this.baseUrl}${this.profilePrefix}/v1${path}`
  }

  private sessionUrl(path: string): string {
    return `${this.baseUrl}${this.profilePrefix}/api/sessions${path}`
  }

  private async requestJsonAt<T>(url: string, init: RequestInit = {}, timeoutMs = this.timeoutMs): Promise<T> {
    const controller = new AbortController()
    const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined
    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          Authorization: `Bearer ${this.apiKey}`,
          ...(init.headers || {}),
        },
      })
      const raw = await response.text()
      let payload: unknown = {}
      if (raw.trim()) {
        try {
          payload = JSON.parse(raw)
        } catch {
          payload = { detail: raw }
        }
      }
      if (!response.ok) {
        throw new GatewayApiError(
          responseErrorMessage(payload, `Hermes Gateway API returned HTTP ${response.status}`),
          { status: response.status, response: payload },
        )
      }
      return payload as T
    } catch (error) {
      if (error instanceof GatewayApiError) throw error
      const code = networkErrorCode(error)
      const message = error instanceof Error ? error.message : String(error)
      throw new GatewayApiError(`Hermes Gateway API request failed: ${message}`, { code })
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private requestJson<T>(path: string, init: RequestInit = {}, timeoutMs = this.timeoutMs): Promise<T> {
    return this.requestJsonAt(this.url(path), init, timeoutMs)
  }

  private requestSessionJson<T>(path: string, init: RequestInit = {}, timeoutMs = this.timeoutMs): Promise<T> {
    return this.requestJsonAt(this.sessionUrl(path), init, timeoutMs)
  }

  async ping(): Promise<Record<string, unknown>> {
    return this.requestJson<Record<string, unknown>>('/capabilities')
  }

  async startRun(options: {
    sessionId: string
    input: unknown
    conversationHistory?: unknown[]
    instructions?: string
    model?: string
    provider?: string
    reasoningEffort?: string
    backgroundDelegationEnabled?: boolean
    workspace?: string
  }): Promise<GatewayRunStartResponse> {
    const modelOptions = options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : undefined
    const policy = [
      options.backgroundDelegationEnabled === false
        ? 'Runtime constraint: do not use background task delegation for this run; execute delegated work synchronously.'
        : '',
      options.workspace
        ? `Working directory for this run: ${options.workspace}. Use it as the workspace for file and shell tools.`
        : '',
    ].filter(Boolean).join('\n')
    const instructions = [options.instructions, policy].filter(Boolean).join('\n')
    // `/v1/runs` treats an array as a message list. Studio's bridge message
    // array is a content-block list, so wrap it as the current user message
    // before sending multimodal input to the Gateway.
    const input = Array.isArray(options.input)
      ? [{ role: 'user', content: options.input }]
      : options.input
    return this.requestJson<GatewayRunStartResponse>('/runs', {
      method: 'POST',
      body: JSON.stringify({
        input,
        session_id: options.sessionId,
        ...(options.conversationHistory ? { conversation_history: options.conversationHistory } : {}),
        ...(instructions ? { instructions } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(options.provider ? { provider: options.provider } : {}),
        ...(modelOptions ? { model_options: modelOptions } : {}),
      }),
    })
  }

  async getRun(runId: string): Promise<GatewayRunResponse> {
    return this.requestJson<GatewayRunResponse>(`/runs/${encodeURIComponent(runId)}`)
  }

  async stopRun(runId: string): Promise<Record<string, unknown>> {
    return this.requestJson<Record<string, unknown>>(`/runs/${encodeURIComponent(runId)}/stop`, { method: 'POST', body: '{}' })
  }

  async steerRun(runId: string, input: string): Promise<Record<string, unknown>> {
    return this.requestJson<Record<string, unknown>>(`/runs/${encodeURIComponent(runId)}/steer`, {
      method: 'POST',
      body: JSON.stringify({ input }),
    })
  }

  async respondToApproval(runId: string, choice: string): Promise<Record<string, unknown>> {
    return this.requestJson<Record<string, unknown>>(`/runs/${encodeURIComponent(runId)}/approval`, {
      method: 'POST',
      body: JSON.stringify({ choice }),
    })
  }

  async listSessions(options: {
    limit?: number
    offset?: number
    source?: string
    includeChildren?: boolean
  } = {}): Promise<GatewaySessionListResponse> {
    const params = new URLSearchParams()
    if (options.limit !== undefined) params.set('limit', String(options.limit))
    if (options.offset !== undefined) params.set('offset', String(options.offset))
    if (options.source) params.set('source', options.source)
    if (options.includeChildren !== undefined) params.set('include_children', String(options.includeChildren))
    const query = params.toString()
    return this.requestSessionJson<GatewaySessionListResponse>(query ? `?${query}` : '')
  }

  async getSession(sessionId: string): Promise<GatewaySessionResponse> {
    return this.requestSessionJson<GatewaySessionResponse>(`/${encodeURIComponent(sessionId)}`)
  }

  async patchSession(sessionId: string, patch: Record<string, unknown>): Promise<GatewaySessionResponse> {
    return this.requestSessionJson<GatewaySessionResponse>(`/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    })
  }

  async deleteSession(sessionId: string): Promise<Record<string, unknown>> {
    return this.requestSessionJson<Record<string, unknown>>(`/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    })
  }

  async getSessionMessages(sessionId: string, options: {
    limit?: number
    offset?: number
    order?: 'oldest' | 'latest'
  } = {}): Promise<GatewaySessionMessagesResponse> {
    const params = new URLSearchParams()
    if (options.limit !== undefined) params.set('limit', String(options.limit))
    if (options.offset !== undefined) params.set('offset', String(options.offset))
    if (options.order) params.set('order', options.order)
    const query = params.toString()
    return this.requestSessionJson<GatewaySessionMessagesResponse>(
      `/${encodeURIComponent(sessionId)}/messages${query ? `?${query}` : ''}`,
    )
  }

  async lockSessionModel(sessionId: string, model: string, provider?: string): Promise<Record<string, unknown>> {
    return this.requestSessionJson<Record<string, unknown>>(`/${encodeURIComponent(sessionId)}/model`, {
      method: 'POST',
      body: JSON.stringify({
        model,
        ...(provider ? { provider } : {}),
      }),
    })
  }

  async *streamRun(runId: string): AsyncGenerator<GatewayRunEvent> {
    const controller = new AbortController()
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      const response = await fetch(this.url(`/runs/${encodeURIComponent(runId)}/events`), {
        headers: {
          Accept: 'text/event-stream',
          Authorization: `Bearer ${this.apiKey}`,
        },
        signal: controller.signal,
      })
      if (!response.ok) {
        const raw = await response.text()
        let payload: unknown = {}
        try { payload = raw ? JSON.parse(raw) : {} } catch { payload = { detail: raw } }
        throw new GatewayApiError(
          responseErrorMessage(payload, `Hermes Gateway event stream returned HTTP ${response.status}`),
          { status: response.status, response: payload },
        )
      }
      if (!response.body) throw new GatewayApiError('Hermes Gateway event stream has no response body')

      reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let eventName = ''
      let dataLines: string[] = []
      const dispatch = (): GatewayRunEvent | undefined => {
        if (!dataLines.length) {
          eventName = ''
          return undefined
        }
        const rawData = dataLines.join('\n')
        dataLines = []
        const currentEventName = eventName
        eventName = ''
        let parsed: unknown = {}
        try { parsed = JSON.parse(rawData) } catch { parsed = { data: rawData } }
        const object = jsonObject(parsed)
        const nestedData = object.data && typeof object.data === 'object' ? object.data as Record<string, unknown> : object
        const normalizedEvent = currentEventName || (typeof object.event === 'string' ? object.event : '')
        return { event: normalizedEvent, data: nestedData }
      }

      for (;;) {
        const next = await reader.read()
        buffer += decoder.decode(next.value || new Uint8Array(), { stream: !next.done })
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() || ''
        for (const line of lines) {
          if (!line.trim()) {
            const event = dispatch()
            if (event) yield event
            continue
          }
          if (line.startsWith(':')) continue
          if (line.startsWith('event:')) {
            eventName = line.slice('event:'.length).trim()
          } else if (line.startsWith('data:')) {
            dataLines.push(line.slice('data:'.length).trimStart())
          }
        }
        if (next.done) break
      }
      if (buffer.trim()) {
        if (buffer.startsWith('data:')) dataLines.push(buffer.slice('data:'.length).trimStart())
        const event = dispatch()
        if (event) yield event
      }
    } catch (error) {
      if (error instanceof GatewayApiError) throw error
      const code = networkErrorCode(error)
      const message = error instanceof Error ? error.message : String(error)
      throw new GatewayApiError(`Hermes Gateway event stream failed: ${message}`, { code })
    } finally {
      try { await reader?.cancel() } catch {}
      controller.abort()
    }
  }
}

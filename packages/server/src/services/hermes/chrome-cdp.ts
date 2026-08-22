import { realpath, readdir, readFile } from 'fs/promises'
import { WebSocket } from 'ws'

export interface ChromeTarget {
  id: string
  type: string
  title?: string
  url?: string
  webSocketDebuggerUrl: string
}

interface ChromeVersion {
  Browser?: string
  browser?: string
  webSocketDebuggerUrl?: string
}

interface CdpMessage {
  id?: number
  result?: unknown
  error?: { message?: string }
}

const DEFAULT_CDP_PORTS = [16002, 9222, 9229]
const DISCOVERY_TIMEOUT_MS = 800
const COMMAND_TIMEOUT_MS = 20_000
let detectedEndpoint = ''
let detecting: Promise<string> | null = null

function normalizeEndpoint(value: string): string {
  const parsed = new URL(value.trim())
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('HERMES_BROWSER_CDP_URL 必须使用 http:// 或 https://')
  }
  return parsed.toString().replace(/\/$/, '')
}

function configuredPorts(): number[] {
  const values = [
    ...String(process.env.HERMES_BROWSER_CDP_PORTS || '').split(','),
    String(process.env.HERMES_BROWSER_CDP_PORT || ''),
    ...DEFAULT_CDP_PORTS.map(String),
  ]
  return [...new Set(values
    .map(value => Number.parseInt(value.trim(), 10))
    .filter(port => port >= 1 && port <= 65535))]
}

async function chromeProcessPorts(): Promise<number[]> {
  if (process.platform !== 'linux') return []
  try {
    const entries = await readdir('/proc', { withFileTypes: true })
    const ports = new Set<number>()
    await Promise.all(entries
      .filter(entry => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map(async entry => {
        try {
          const commandLine = (await readFile(`/proc/${entry.name}/cmdline`, 'utf8')).replaceAll('\0', ' ')
          let executablePath = ''
          try {
            executablePath = await realpath(`/proc/${entry.name}/exe`)
          } catch {
            // /proc access may be restricted for another user.
          }
          if (!/(?:chrome|chromium)/i.test(executablePath) && !/(?:chrome|chromium)/i.test(commandLine)) return
          for (const match of commandLine.matchAll(/(?:^|\s)--remote-debugging-port(?:=|\s+)(\d+)(?:\s|$)/g)) {
            const port = Number.parseInt(match[1], 10)
            if (port >= 1 && port <= 65535) ports.add(port)
          }
        } catch {
          // A process may exit while discovery is running.
        }
      }))
    return [...ports]
  } catch {
    return []
  }
}

async function probe(endpoint: string): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS)
  try {
    const response = await fetch(`${endpoint}/json/version`, { signal: controller.signal })
    if (!response.ok) return false
    const payload = await response.json() as ChromeVersion
    const browser = String(payload.Browser || payload.browser || '')
    return Boolean(payload.webSocketDebuggerUrl) && /(?:Chrome|Chromium|HeadlessChrome)\//i.test(browser)
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

async function candidateEndpoints(): Promise<string[]> {
  const configuredUrl = String(process.env.HERMES_BROWSER_CDP_URL || '').trim()
  if (configuredUrl) return [normalizeEndpoint(configuredUrl)]
  const ports = [...new Set([...(await chromeProcessPorts()), ...configuredPorts()])]
  return ports.map(port => `http://127.0.0.1:${port}`)
}

export function resetChromeCdpDiscovery(): void {
  detectedEndpoint = ''
}

export async function resolveChromeCdpEndpoint(): Promise<string> {
  const configuredUrl = String(process.env.HERMES_BROWSER_CDP_URL || '').trim()
  if (configuredUrl) return normalizeEndpoint(configuredUrl)
  if (detectedEndpoint) return detectedEndpoint
  detecting ||= (async () => {
    const candidates = await candidateEndpoints()
    for (const candidate of candidates) {
      if (await probe(candidate)) {
        detectedEndpoint = candidate
        return candidate
      }
    }
    throw new Error(`未检测到启用远程调试的 fnOS Chrome/Chromium。已检查：${candidates.join('、') || '没有可用端口'}。请使用 --remote-debugging-port 启动浏览器。`)
  })()
  try {
    return await detecting
  } finally {
    detecting = null
  }
}

export async function chromeCdpRequest<T = unknown>(pathname: string, options: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
  const timeoutMs = options.timeoutMs || COMMAND_TIMEOUT_MS
  let timer: NodeJS.Timeout | undefined
  try {
    const endpoint = await resolveChromeCdpEndpoint()
    const controller = new AbortController()
    timer = setTimeout(() => controller.abort(), timeoutMs)
    const response = await fetch(new URL(pathname, `${endpoint}/`), {
      method: options.method || 'GET',
      headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    })
    const text = await response.text()
    let payload: unknown = text
    try {
      payload = text ? JSON.parse(text) : null
    } catch {
      // /json/activate and /json/close may return plain text.
    }
    if (!response.ok) {
      const detail = typeof payload === 'string' ? payload : JSON.stringify(payload)
      throw new Error(`Chrome CDP HTTP ${response.status}: ${detail || response.statusText}`)
    }
    return payload as T
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error(`Chrome CDP 请求超时（${timeoutMs}ms）`)
    if (error instanceof TypeError) {
      resetChromeCdpDiscovery()
      throw new Error(`Chrome CDP 不可用：${error.message}`)
    }
    throw error
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function listChromeTargets(): Promise<ChromeTarget[]> {
  const payload = await chromeCdpRequest<unknown[]>('/json')
  if (!Array.isArray(payload)) throw new Error('Chrome CDP 返回了无效的标签页列表')
  return payload.filter((target: unknown): target is ChromeTarget => {
    if (!target || typeof target !== 'object') return false
    const candidate = target as Partial<ChromeTarget>
    return candidate.type === 'page' &&
      typeof candidate.id === 'string' &&
      typeof candidate.webSocketDebuggerUrl === 'string'
  })
}

export async function createChromeTarget(url = 'about:blank'): Promise<ChromeTarget> {
  const encodedUrl = encodeURI(url).replace(/#/g, '%23')
  let target: ChromeTarget
  try {
    target = await chromeCdpRequest<ChromeTarget>(`/json/new?${encodedUrl}`, { method: 'PUT' })
  } catch (firstError) {
    try {
      target = await chromeCdpRequest<ChromeTarget>(`/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
    } catch {
      throw firstError
    }
  }
  if (!target?.id || !target.webSocketDebuggerUrl) throw new Error('Chrome CDP 未返回新标签页')
  return target
}

export async function activateChromeTarget(targetId: string): Promise<void> {
  await chromeCdpRequest(`/json/activate/${encodeURIComponent(targetId)}`)
}

export async function closeChromeTarget(targetId: string): Promise<void> {
  await chromeCdpRequest(`/json/close/${encodeURIComponent(targetId)}`)
}

export class ChromeCdpConnection {
  private readonly socket: WebSocket
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()

  private constructor(socket: WebSocket) {
    this.socket = socket
    this.socket.on('message', data => this.handleMessage(String(data)))
    this.socket.on('close', () => this.rejectPending(new Error('Chrome CDP WebSocket 已断开')))
    this.socket.on('error', error => this.rejectPending(new Error(`Chrome CDP WebSocket 错误：${error.message}`)))
  }

  static async connect(target: ChromeTarget): Promise<ChromeCdpConnection> {
    const socket = new WebSocket(target.webSocketDebuggerUrl, { handshakeTimeout: 5000 })
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => { cleanup(); resolve() }
      const onError = (error: Error) => { cleanup(); reject(new Error(`Chrome CDP WebSocket 连接失败：${error.message}`)) }
      const cleanup = () => { socket.off('open', onOpen); socket.off('error', onError) }
      socket.once('open', onOpen)
      socket.once('error', onError)
    })
    return new ChromeCdpConnection(socket)
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = COMMAND_TIMEOUT_MS): Promise<T> {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Chrome CDP WebSocket 未连接'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Chrome CDP 命令 ${method} 超时`))
      }, timeoutMs)
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer })
      this.socket.send(JSON.stringify({ id, method, params }), error => {
        if (!error) return
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error(`Chrome CDP 命令 ${method} 发送失败：${error.message}`))
      })
    })
  }

  close(): void {
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) this.socket.close()
    this.rejectPending(new Error('Chrome CDP 连接已关闭'))
  }

  private handleMessage(raw: string): void {
    let message: CdpMessage
    try { message = JSON.parse(raw) as CdpMessage } catch { return }
    if (!message.id) return
    const pending = this.pending.get(message.id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(message.id)
    if (message.error) pending.reject(new Error(message.error.message || 'Chrome CDP 命令失败'))
    else pending.resolve(message.result)
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      this.pending.delete(id)
      pending.reject(error)
    }
  }
}

import { spawn } from 'child_process'
import { createServer, type Server as NetServer } from 'net'
import { mkdir } from 'fs/promises'
import { join } from 'path'
import { WebSocket, WebSocketServer } from 'ws'
import type { Server as HttpServer } from 'http'
import { authenticateUserToken, isAuthEnabled } from '../../middleware/user-auth'
import { config, stripPublicBasePath } from '../../config'
import { shouldRejectUpgradeOrigin, writeForbiddenOrigin } from '../../security'
import { logger } from '../logger'

const MAX_COMMAND_OUTPUT = 128 * 1024
const COMMAND_TIMEOUT_MS = 45_000
const INSTALL_TIMEOUT_MS = 180_000
const DEFAULT_URL = 'about:blank'

interface BrowserSession {
  key: string
  sessionName: string
  streamPort: number
  initialized: boolean
  initializing?: Promise<void>
  installing?: Promise<void>
}

interface BrowserCommandResult {
  stdout: string
  stderr: string
}

function sessionKey(userId: number, profile: string): string {
  const safeProfile = profile.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 32) || 'default'
  return `u${userId}-${safeProfile}`
}

function sessionName(key: string): string {
  return `hermes-fnos-${key}`
}

function browserHome(): string {
  return join(config.appHome, 'browser')
}

function browserDataDir(userId: number): string {
  return join(browserHome(), 'profiles', String(userId))
}

function browserCommand(): string {
  return process.env.HERMES_AGENT_BROWSER_BIN?.trim() || 'agent-browser'
}

function makeBrowserEnv(session: BrowserSession, userId: number): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AGENT_BROWSER_HOME: browserHome(),
    AGENT_BROWSER_SESSION: session.sessionName,
    AGENT_BROWSER_STREAM_PORT: String(session.streamPort),
    AGENT_BROWSER_DOWNLOAD_PATH: join(browserDataDir(userId), 'downloads'),
    AGENT_BROWSER_ARGS: '--no-sandbox,--disable-dev-shm-usage',
    AGENT_BROWSER_IDLE_TIMEOUT_MS: '0',
  }
}

function runCommand(args: string[], env: NodeJS.ProcessEnv, timeoutMs = COMMAND_TIMEOUT_MS): Promise<BrowserCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(browserCommand(), args, {
      env,
      cwd: config.appHome,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve({ stdout, stderr })
    }
    const append = (target: 'stdout' | 'stderr', chunk: Buffer | string) => {
      const value = String(chunk)
      if (target === 'stdout') stdout = `${stdout}${value}`.slice(-MAX_COMMAND_OUTPUT)
      else stderr = `${stderr}${value}`.slice(-MAX_COMMAND_OUTPUT)
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish(new Error('本机浏览器操作超时'))
    }, timeoutMs)
    child.stdout.on('data', chunk => append('stdout', chunk))
    child.stderr.on('data', chunk => append('stderr', chunk))
    child.once('error', error => finish(error))
    child.once('close', code => {
      if (code !== 0) {
        const detail = stderr.trim() || stdout.trim() || `exit ${String(code)}`
        finish(new Error(detail.slice(-2000)))
        return
      }
      finish()
    })
  })
}

async function reservePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server: NetServer = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(error => error ? reject(error) : resolve(port))
    })
  })
}

function cleanUrl(value: unknown): string {
  const raw = String(value || '').trim()
  if (!raw) throw new Error('请输入网页地址')
  const candidate = raw.includes('://') ? raw : `https://${raw}`
  if (candidate === DEFAULT_URL) return candidate
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    throw new Error('网页地址格式不正确')
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('内置浏览器只允许打开 HTTP 或 HTTPS 地址')
  }
  if (parsed.username || parsed.password) {
    throw new Error('网页地址不能包含账号密码')
  }
  return parsed.toString()
}

class FnosBrowserManager {
  private readonly sessions = new Map<string, BrowserSession>()

  async getState(userId: number, profile: string): Promise<{ ready: boolean; url: string; streamPort: number }> {
    const session = await this.ensureSession(userId, profile)
    const result = await this.run(session, userId, ['get', 'url'])
    return {
      ready: true,
      url: result.stdout.trim() || DEFAULT_URL,
      streamPort: session.streamPort,
    }
  }

  async navigate(userId: number, profile: string, value: unknown): Promise<{ url: string }> {
    const url = cleanUrl(value)
    const session = await this.ensureSession(userId, profile)
    await this.run(session, userId, ['open', url])
    return { url }
  }

  async action(userId: number, profile: string, value: unknown): Promise<{ url: string }> {
    const action = String(value || '').trim()
    if (!['back', 'forward', 'reload'].includes(action)) throw new Error('不支持的浏览器操作')
    const session = await this.ensureSession(userId, profile)
    await this.run(session, userId, [action])
    const current = await this.run(session, userId, ['get', 'url'])
    return { url: current.stdout.trim() || DEFAULT_URL }
  }

  async close(userId: number, profile: string): Promise<void> {
    const key = sessionKey(userId, profile)
    const session = this.sessions.get(key)
    if (!session) return
    await this.run(session, userId, ['close']).catch(error => logger.debug({ error }, '[fnos-browser] close failed'))
    this.sessions.delete(key)
  }

  async proxyStream(userId: number, profile: string, frontend: WebSocket): Promise<void> {
    const session = await this.ensureSession(userId, profile)
    const upstream = new WebSocket(`ws://127.0.0.1:${session.streamPort}`)
    let closed = false
    const closeBoth = () => {
      if (closed) return
      closed = true
      if (frontend.readyState === WebSocket.OPEN || frontend.readyState === WebSocket.CONNECTING) frontend.close()
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close()
    }
    frontend.on('message', data => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data)
    })
    frontend.once('close', () => {
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close()
    })
    frontend.once('error', closeBoth)
    upstream.on('open', () => {
      if (frontend.readyState === WebSocket.OPEN) frontend.send(JSON.stringify({ type: 'ready' }))
    })
    upstream.on('message', data => {
      if (frontend.readyState === WebSocket.OPEN) frontend.send(data)
    })
    upstream.once('close', closeBoth)
    upstream.once('error', error => {
      logger.warn({ error }, '[fnos-browser] stream proxy failed')
      if (frontend.readyState === WebSocket.OPEN) frontend.send(JSON.stringify({ type: 'error', message: '本机浏览器画面连接失败' }))
      closeBoth()
    })
  }

  private async ensureSession(userId: number, profile: string): Promise<BrowserSession> {
    const key = sessionKey(userId, profile)
    let session = this.sessions.get(key)
    if (!session) {
      session = { key, sessionName: sessionName(key), streamPort: await reservePort(), initialized: false }
      this.sessions.set(key, session)
    }
    if (!session.initialized) {
      session.initializing ||= this.initializeSession(session, userId)
      try {
        await session.initializing
      } finally {
        session.initializing = undefined
      }
    }
    return session
  }

  private async initializeSession(session: BrowserSession, userId: number): Promise<void> {
    await mkdir(browserDataDir(userId), { recursive: true })
    const env = makeBrowserEnv(session, userId)
    try {
      await this.run(session, userId, ['open', DEFAULT_URL])
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!/browser|chrom|executable|install|not found/i.test(message)) throw error
      session.installing ||= this.installBrowser(session, userId)
      try {
        await session.installing
      } finally {
        session.installing = undefined
      }
      await this.run(session, userId, ['open', DEFAULT_URL])
    }
    await this.run(session, userId, ['stream', 'enable', '--port', String(session.streamPort)])
    session.initialized = true
  }

  private async installBrowser(session: BrowserSession, userId: number): Promise<void> {
    await runCommand(['install'], makeBrowserEnv(session, userId), INSTALL_TIMEOUT_MS)
  }

  private run(session: BrowserSession, userId: number, args: string[]): Promise<BrowserCommandResult> {
    return runCommand(['--session', session.sessionName, ...args], makeBrowserEnv(session, userId))
  }
}

export const fnosBrowserManager = new FnosBrowserManager()

export function setupFnosBrowserWebSocket(httpServers: HttpServer | HttpServer[]): void {
  const wss = new WebSocketServer({ noServer: true })
  const servers = Array.isArray(httpServers) ? httpServers : [httpServers]
  for (const httpServer of servers) {
    httpServer.on('upgrade', async (req, socket, head) => {
      const url = new URL(req.url || '', `http://${req.headers.host}`)
      if (stripPublicBasePath(url.pathname, config.publicBasePath) !== '/api/hermes/browser/stream') return
      if (shouldRejectUpgradeOrigin(req, config.corsOrigins)) {
        writeForbiddenOrigin(socket)
        return
      }
      const user = (await isAuthEnabled())
        ? await authenticateUserToken(url.searchParams.get('token') || '')
        : { id: 1 }
      if (!user) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }
      const profile = url.searchParams.get('profile') || 'default'
      wss.handleUpgrade(req, socket, head, ws => {
        wss.emit('connection', ws, { userId: user.id, profile })
      })
    })
  }
  wss.on('connection', (ws, context: { userId: number; profile: string }) => {
    void fnosBrowserManager.proxyStream(context.userId, context.profile, ws).catch(error => {
      logger.warn({ error }, '[fnos-browser] failed to start stream')
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'error', message: error instanceof Error ? error.message : '本机浏览器启动失败' }))
      ws.close()
    })
  })
}

export { cleanUrl }

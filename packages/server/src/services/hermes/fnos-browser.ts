import { WebSocket, WebSocketServer } from 'ws'
import type { Server as HttpServer } from 'http'
import { authenticateUserToken, isAuthEnabled } from '../../middleware/user-auth'
import { config, stripPublicBasePath } from '../../config'
import { shouldRejectUpgradeOrigin, writeForbiddenOrigin } from '../../security'
import { logger } from '../logger'
import {
  activateChromeTarget,
  ChromeCdpConnection,
  closeChromeTarget,
  createChromeTarget,
  listChromeTargets,
  type ChromeTarget,
} from './chrome-cdp'

const DEFAULT_URL = 'about:blank'
const FRAME_INTERVAL_MS = 350

interface BrowserSession {
  targetId?: string
}

interface StreamInputPayload {
  type?: string
  eventType?: string
  x?: number
  y?: number
  button?: string
  clickCount?: number
  deltaX?: number
  deltaY?: number
  key?: string
  code?: string
}

function sessionKey(userId: number, profile: string): string {
  const safeProfile = profile.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 32) || 'default'
  return `u${userId}-${safeProfile}`
}

function cleanUrl(value: unknown): string {
  const raw = String(value || '').trim()
  if (!raw) throw new Error('请输入网页地址')
  const candidate = raw.includes('://') ? raw : `https://${raw}`
  if (candidate === DEFAULT_URL) return candidate
  let parsed: URL
  try { parsed = new URL(candidate) } catch { throw new Error('网页地址格式不正确') }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('浏览器只允许打开 HTTP 或 HTTPS 地址')
  if (parsed.username || parsed.password) throw new Error('网页地址不能包含账号密码')
  return parsed.toString()
}

function numberValue(value: unknown, fallback = 0): number {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

class FnosBrowserManager {
  private readonly sessions = new Map<string, BrowserSession>()

  async getState(userId: number, profile: string): Promise<{ ready: boolean; url: string; streamPort: number }> {
    const session = this.getSession(userId, profile)
    const target = await this.getTarget(session)
    return { ready: true, url: target.url || DEFAULT_URL, streamPort: 0 }
  }

  async navigate(userId: number, profile: string, value: unknown): Promise<{ url: string }> {
    const url = cleanUrl(value)
    const session = this.getSession(userId, profile)
    const target = await this.getTarget(session)
    await activateChromeTarget(target.id)
    const connection = await ChromeCdpConnection.connect(target)
    try {
      await connection.send('Page.navigate', { url })
      return { url }
    } finally {
      connection.close()
    }
  }

  async action(userId: number, profile: string, value: unknown): Promise<{ url: string }> {
    const action = String(value || '').trim()
    if (!['back', 'forward', 'reload'].includes(action)) throw new Error('不支持的浏览器操作')
    const session = this.getSession(userId, profile)
    const target = await this.getTarget(session)
    const connection = await ChromeCdpConnection.connect(target)
    try {
      if (action === 'reload') {
        await connection.send('Page.reload')
      } else {
        const history = await connection.send<{ entries?: Array<{ id: number }>; currentIndex?: number }>('Page.getNavigationHistory')
        const currentIndex = Number(history.currentIndex || 0)
        const nextIndex = action === 'back' ? currentIndex - 1 : currentIndex + 1
        const entry = history.entries?.[nextIndex]
        if (entry) await connection.send('Page.navigateToHistoryEntry', { entryId: entry.id })
      }
    } finally {
      connection.close()
    }
    const refreshed = await this.getTarget(session)
    return { url: refreshed.url || DEFAULT_URL }
  }

  async close(userId: number, profile: string): Promise<void> {
    const key = sessionKey(userId, profile)
    const session = this.sessions.get(key)
    if (!session?.targetId) return
    await closeChromeTarget(session.targetId).catch(error => logger.debug({ error }, '[fnos-browser] close tab failed'))
    this.sessions.delete(key)
  }

  async proxyStream(userId: number, profile: string, frontend: WebSocket): Promise<void> {
    const session = this.getSession(userId, profile)
    const target = await this.getTarget(session)
    await activateChromeTarget(target.id)
    const connection = await ChromeCdpConnection.connect(target)
    let frameTimer: NodeJS.Timeout | undefined
    let capturing = false
    let closed = false

    const finish = () => {
      if (closed) return
      closed = true
      if (frameTimer) clearInterval(frameTimer)
      connection.close()
      if (frontend.readyState === WebSocket.OPEN || frontend.readyState === WebSocket.CONNECTING) frontend.close()
    }
    const sendError = (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      if (frontend.readyState === WebSocket.OPEN) frontend.send(JSON.stringify({ type: 'error', message }))
    }
    const captureFrame = async () => {
      if (capturing || closed || frontend.readyState !== WebSocket.OPEN) return
      capturing = true
      try {
        const screenshot = await connection.send<{ data?: string }>('Page.captureScreenshot', {
          format: 'jpeg',
          quality: 78,
          fromSurface: true,
        })
        if (!screenshot.data) throw new Error('Chrome CDP 未返回浏览器画面')
        const metrics = await connection
          .send<{ cssVisualViewport?: { clientWidth?: number; clientHeight?: number } }>('Page.getLayoutMetrics')
          .catch((): { cssVisualViewport?: { clientWidth?: number; clientHeight?: number } } => ({}))
        const viewport = metrics.cssVisualViewport
        frontend.send(JSON.stringify({
          type: 'frame',
          data: screenshot.data,
          metadata: {
            deviceWidth: viewport?.clientWidth || 1280,
            deviceHeight: viewport?.clientHeight || 720,
          },
        }))
      } catch (error) {
        sendError(error)
        finish()
      } finally {
        capturing = false
      }
    }
    const handleInput = async (payload: StreamInputPayload) => {
      if (payload.type === 'input_mouse') {
        const eventType = ['mouseMoved', 'mousePressed', 'mouseReleased', 'mouseWheel'].includes(String(payload.eventType))
          ? String(payload.eventType)
          : ''
        if (!eventType) return
        const params: Record<string, unknown> = {
          type: eventType,
          x: numberValue(payload.x),
          y: numberValue(payload.y),
        }
        if (eventType === 'mouseWheel') {
          params.deltaX = numberValue(payload.deltaX)
          params.deltaY = numberValue(payload.deltaY)
        } else if (eventType !== 'mouseMoved') {
          params.button = payload.button === 'right' || payload.button === 'middle' ? payload.button : 'left'
          params.clickCount = Math.max(1, Math.round(numberValue(payload.clickCount, 1)))
        }
        await connection.send('Input.dispatchMouseEvent', params)
      } else if (payload.type === 'input_keyboard') {
        const eventType = payload.eventType === 'keyUp' ? 'keyUp' : 'keyDown'
        const key = String(payload.key || '')
        const params: Record<string, unknown> = {
          type: eventType,
          key,
          code: String(payload.code || ''),
        }
        if (eventType === 'keyDown' && [...key].length === 1) params.text = key
        await connection.send('Input.dispatchKeyEvent', params)
      }
    }

    frontend.on('message', data => {
      try {
        const payload = JSON.parse(String(data)) as StreamInputPayload
        void handleInput(payload).catch(error => sendError(error))
      } catch {
        sendError(new Error('浏览器输入消息格式无效'))
      }
    })
    frontend.once('close', finish)
    frontend.once('error', finish)
    await connection.send('Page.enable')
    await connection.send('Runtime.enable').catch(() => undefined)
    if (frontend.readyState === WebSocket.OPEN) frontend.send(JSON.stringify({ type: 'ready' }))
    await captureFrame()
    if (!closed) frameTimer = setInterval(() => { void captureFrame() }, FRAME_INTERVAL_MS)
  }

  private getSession(userId: number, profile: string): BrowserSession {
    const key = sessionKey(userId, profile)
    let session = this.sessions.get(key)
    if (!session) {
      session = {}
      this.sessions.set(key, session)
    }
    return session
  }

  private async getTarget(session: BrowserSession): Promise<ChromeTarget> {
    const targets = await listChromeTargets()
    let target = session.targetId ? targets.find(item => item.id === session.targetId) : undefined
    if (!target) target = targets[0]
    if (!target) target = await createChromeTarget()
    session.targetId = target.id
    return target
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
      wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, { userId: user.id, profile }))
    })
  }
  wss.on('connection', (ws, context: { userId: number; profile: string }) => {
    void fnosBrowserManager.proxyStream(context.userId, context.profile, ws).catch(error => {
      logger.warn({ error }, '[fnos-browser] Chrome CDP stream failed')
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'error', message: error instanceof Error ? error.message : 'NAS Chrome 画面连接失败' }))
      ws.close()
    })
  })
}

export { cleanUrl }

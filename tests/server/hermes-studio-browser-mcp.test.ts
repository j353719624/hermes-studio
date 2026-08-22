import { createServer, type Server } from 'node:http'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'

let child: ChildProcessWithoutNullStreams | null = null
let httpServer: Server | null = null
let wsServer: WebSocketServer | null = null

afterEach(async () => {
  child?.kill()
  child = null
  await new Promise<void>(resolve => {
    if (!httpServer) return resolve()
    httpServer.close(() => resolve())
    httpServer = null
  })
  await new Promise<void>(resolve => {
    if (!wsServer) return resolve()
    wsServer.close(() => resolve())
    wsServer = null
  })
})

function rpcClient(process: ChildProcessWithoutNullStreams) {
  let buffer = ''
  const responses = new Map<number, any>()
  const waiters = new Map<number, (value: any) => void>()
  process.stdout.on('data', chunk => {
    buffer += String(chunk)
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line) {
        const response = JSON.parse(line)
        const waiter = waiters.get(response.id)
        if (waiter) { waiters.delete(response.id); waiter(response) } else responses.set(response.id, response)
      }
      newline = buffer.indexOf('\n')
    }
  })
  return async (id: number, method: string, params: Record<string, unknown> = {}) => {
    process.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    const existing = responses.get(id)
    if (existing) { responses.delete(id); return existing }
    return await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`RPC ${id} timed out`)), 5000)
      waiters.set(id, value => { clearTimeout(timer); resolve(value) })
    })
  }
}

async function listen(server: Server | WebSocketServer): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.once('listening', () => resolve())
    server.listen(0, '127.0.0.1')
  })
  return (server.address() as { port: number }).port
}

async function startFakeCdp() {
  wsServer = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>((resolve, reject) => {
    wsServer?.once('error', reject)
    wsServer?.once('listening', () => resolve())
  })
  const wsPort = (wsServer.address() as { port: number }).port
  const target = {
    id: 'page-1',
    type: 'page',
    title: 'fnOS Chrome',
    url: 'https://example.test/',
    webSocketDebuggerUrl: `ws://127.0.0.1:${wsPort}/devtools/page/page-1`,
  }
  wsServer.on('connection', socket => {
    socket.on('message', raw => {
      const request = JSON.parse(String(raw))
      let result: Record<string, unknown> = {}
      if (request.method === 'Page.navigate') result = { frameId: 'frame-1' }
      if (request.method === 'Page.getLayoutMetrics') result = { cssContentSize: { width: 1024, height: 768 } }
      if (request.method === 'Page.captureScreenshot') result = { data: Buffer.from('fake-png').toString('base64') }
      if (request.method === 'Runtime.evaluate') {
        const expression = String(request.params?.expression || '')
        if (expression.includes('removeAttribute')) {
          result = { result: { type: 'object', value: { snapshot: '[e1] button: OK', refs: { e1: { role: 'button', name: 'OK', tag: 'button' } }, url: target.url, title: target.title } } }
        } else if (expression.includes('__hermesStudioMcpConsole')) {
          result = { result: { type: 'object', value: { success: true, entries: [] } } }
        } else {
          result = { result: { type: 'boolean', value: true } }
        }
      }
      socket.send(JSON.stringify({ id: request.id, result }))
    })
  })

  httpServer = createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1')
    if (url.pathname === '/json/version' && request.method === 'GET') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ Browser: 'Chrome/140.0.0.0', 'Protocol-Version': '1.3', webSocketDebuggerUrl: target.webSocketDebuggerUrl }))
      return
    }
    if (url.pathname === '/json' && request.method === 'GET') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify([target]))
      return
    }
    if (url.pathname === '/json/new' && request.method === 'PUT') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(target))
      return
    }
    if (url.pathname.startsWith('/json/activate/') || url.pathname.startsWith('/json/close/')) {
      response.statusCode = 200
      response.end('OK')
      return
    }
    response.statusCode = 404
    response.end('Not found')
  })
  const httpPort = await listen(httpServer)
  return `http://127.0.0.1:${httpPort}`
}

function startMcp(cdpUrl?: string, cdpPorts?: string) {
  const env = { ...process.env }
  delete env.HERMES_BROWSER_CDP_URL
  delete env.HERMES_BROWSER_CDP_PORTS
  if (cdpUrl) env.HERMES_BROWSER_CDP_URL = cdpUrl
  if (cdpPorts) env.HERMES_BROWSER_CDP_PORTS = cdpPorts
  child = spawn(process.execPath, [join(process.cwd(), 'bin/hermes-studio-mcp.mjs'), 'browser'], {
    env: { ...env, HERMES_WEB_UI_HOME: process.cwd(), HERMES_WEB_UI_PROFILE: 'default' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  return rpcClient(child)
}

describe('hermes-studio fnOS Chrome CDP browser MCP toolset', () => {
  it('always exposes the fnOS browser tool and reports a clear CDP error', async () => {
    const rpc = startMcp('http://127.0.0.1:1')
    const listed = await rpc(1, 'tools/list')
    expect(listed.result.tools).toHaveLength(1)
    expect(listed.result.tools[0].name).toBe('hermes_studio_browser_toolset')

    const unavailable = await rpc(2, 'tools/call', {
      name: 'hermes_studio_browser_toolset',
      arguments: {
        action: 'call',
        tool: 'hermes_studio_browser_tabs',
        arguments: { action: 'list' },
      },
    })
    expect(unavailable.result.isError).toBe(true)
    expect(unavailable.result.content[0].text).toContain('Chrome CDP')
    expect(unavailable.result.content[0].text).not.toContain('Broker')
    expect(child?.exitCode).toBeNull()
  })

  it('lists existing Chrome tabs and dispatches CDP navigation, snapshot, interaction, and screenshot', async () => {
    const cdpUrl = await startFakeCdp()
    const rpc = startMcp(undefined, String(new URL(cdpUrl).port))

    const listed = await rpc(1, 'tools/call', {
      name: 'hermes_studio_browser_toolset',
      arguments: {
        action: 'call',
        tool: 'hermes_studio_browser_tabs',
        arguments: { action: 'list' },
      },
    })
    expect(listed.result.isError).not.toBe(true)
    const tabs = JSON.parse(listed.result.content[0].text)
    expect(tabs.result.tabs[0]).toMatchObject({ tab_id: 'page-1', legacy_tab_id: 't1', title: 'fnOS Chrome' })

    const navigated = await rpc(2, 'tools/call', {
      name: 'hermes_studio_browser_toolset',
      arguments: {
        action: 'call',
        tool: 'hermes_studio_browser_navigate',
        arguments: { tab_id: 'page-1', action: 'open', url: 'https://example.test/next' },
      },
    })
    expect(navigated.result.isError).not.toBe(true)

    const snapshotResponse = await rpc(3, 'tools/call', {
      name: 'hermes_studio_browser_toolset',
      arguments: {
        action: 'call',
        tool: 'hermes_studio_browser_snapshot',
        arguments: { tab_id: 'page-1' },
      },
    })
    const snapshot = JSON.parse(snapshotResponse.result.content[0].text)
    expect(snapshot.result.snapshot_id).toBeTruthy()

    const clicked = await rpc(4, 'tools/call', {
      name: 'hermes_studio_browser_toolset',
      arguments: {
        action: 'call',
        tool: 'hermes_studio_browser_interact',
        arguments: { tab_id: 'page-1', action: 'click', snapshot_id: snapshot.result.snapshot_id, ref: 'e1' },
      },
    })
    expect(clicked.result.isError).not.toBe(true)

    const screenshot = await rpc(5, 'tools/call', {
      name: 'hermes_studio_browser_toolset',
      arguments: {
        action: 'call',
        tool: 'hermes_studio_browser_screenshot',
        arguments: { tab_id: 'page-1' },
      },
    })
    expect(screenshot.result.isError).not.toBe(true)
    expect(screenshot.result.content.some((item: any) => item.type === 'image' && item.mimeType === 'image/png')).toBe(true)
  })
})

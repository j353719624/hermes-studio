import type { Server } from 'node:http'
import { chmod, mkdir, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import type Koa from 'koa'

export interface ListenOptions {
  port: number
  host: string
  unixSocketPath?: string
  unixSocketMode?: number
}

export interface ListenResult {
  primary: Server
  servers: Server[]
  unixSocketPath: string
}

function waitForListen(server: Server): Promise<Server> {
  return new Promise((resolve, reject) => {
    server.once('listening', () => resolve(server))
    server.once('error', reject)
  })
}

async function listenTcp(app: Koa, port: number, host: string): Promise<Server> {
  return waitForListen(app.listen(port, host))
}

async function listenUnix(app: Koa, socketPath: string, mode: number): Promise<Server> {
  await mkdir(dirname(socketPath), { recursive: true })
  await unlink(socketPath).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') throw err
  })
  const server = await waitForListen(app.listen(socketPath))
  await chmod(socketPath, mode)
  return server
}

export async function listenForConfig(app: Koa, options: ListenOptions): Promise<ListenResult> {
  const socketPath = options.unixSocketPath?.trim() || ''
  if (!socketPath) {
    const primary = await listenTcp(app, options.port, options.host || '0.0.0.0')
    return { primary, servers: [primary], unixSocketPath: '' }
  }

  const primary = await listenUnix(app, socketPath, options.unixSocketMode ?? 0o660)
  try {
    // Some Studio services make authenticated loopback calls. Keep those on an
    // ephemeral loopback port while all user traffic stays on the Unix Socket.
    const internal = await listenTcp(app, 0, '127.0.0.1')
    return { primary, servers: [primary, internal], unixSocketPath: socketPath }
  } catch (err) {
    primary.close()
    await unlink(socketPath).catch(() => undefined)
    throw err
  }
}

export function getLoopbackBaseUrl(servers: Server[], fallbackPort: number): string {
  for (const server of servers) {
    const address = server.address()
    if (typeof address === 'object' && address?.port) {
      return `http://127.0.0.1:${address.port}`
    }
  }
  return `http://127.0.0.1:${fallbackPort}`
}

export async function removeUnixSocket(socketPath: string): Promise<void> {
  if (!socketPath) return
  await unlink(socketPath).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') throw err
  })
}

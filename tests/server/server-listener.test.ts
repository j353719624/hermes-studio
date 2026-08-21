import { chmodSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Koa from 'koa'
import { afterEach, describe, expect, it } from 'vitest'
import { listenForConfig, removeUnixSocket } from '../../packages/server/src/services/server-listener'

describe.skipIf(process.platform === 'win32')('Unix Socket listener', () => {
  const roots: string[] = []

  afterEach(() => {
    roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }))
  })

  it('replaces a stale socket path and applies the configured mode', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hermes-fnos-socket-'))
    roots.push(root)
    const socketPath = join(root, 'app.sock')
    writeFileSync(socketPath, 'stale')
    chmodSync(socketPath, 0o600)
    const app = new Koa()
    app.use((ctx) => { ctx.body = { ok: true } })

    const result = await listenForConfig(app, {
      port: 0,
      host: '127.0.0.1',
      unixSocketPath: socketPath,
      unixSocketMode: 0o660,
    })
    try {
      expect(lstatSync(socketPath).isSocket()).toBe(true)
      expect(lstatSync(socketPath).mode & 0o777).toBe(0o660)
      expect(result.servers).toHaveLength(2)
    } finally {
      await Promise.all(result.servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))))
      await removeUnixSocket(socketPath)
    }
  })
})

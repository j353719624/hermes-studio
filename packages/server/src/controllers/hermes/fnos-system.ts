import type { Context } from 'koa'
import { getHermesFnosSystemInfo } from '../../services/fnos/system-info'

const ALLOWED_VIEWS = new Set(['info', 'uptime', 'trim-version', 'is-trim-machine'])

export async function info(ctx: Context): Promise<void> {
  const data = await getHermesFnosSystemInfo()
  const view = typeof ctx.query.view === 'string' ? ctx.query.view.trim() : ''

  if (!view || view === 'info') {
    ctx.body = data
    return
  }

  if (!ALLOWED_VIEWS.has(view)) {
    ctx.status = 400
    ctx.body = { error: 'Unsupported fnOS system information view' }
    return
  }

  if (view === 'uptime') {
    ctx.body = { uptimeSeconds: data.uptimeSeconds }
  } else if (view === 'trim-version') {
    ctx.body = { trimVersion: data.trimVersion }
  } else {
    ctx.body = { isTrimMachine: data.isTrimMachine }
  }
}

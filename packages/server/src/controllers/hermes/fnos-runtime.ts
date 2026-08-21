import type { Context } from 'koa'
import {
  getFnosRuntimeStatus,
  startFnosRuntimeUpgrade,
} from '../../services/fnos-runtime-updater'

export async function status(ctx: Context): Promise<void> {
  try {
    ctx.body = await getFnosRuntimeStatus()
  } catch (error) {
    ctx.status = 404
    ctx.body = { error: error instanceof Error ? error.message : String(error) }
  }
}

export async function upgrade(ctx: Context): Promise<void> {
  const body = ctx.request.body as { version?: unknown }
  const version = typeof body?.version === 'string' ? body.version : ''
  try {
    ctx.status = 202
    ctx.body = { success: true, job: await startFnosRuntimeUpgrade(version) }
  } catch (error) {
    ctx.status = 400
    ctx.body = { error: error instanceof Error ? error.message : String(error) }
  }
}

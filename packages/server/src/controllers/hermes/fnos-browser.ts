import type { Context } from 'koa'
import { fnosBrowserManager } from '../../services/hermes/fnos-browser'

function userId(ctx: Context): number {
  const value = Number(ctx.state.user?.id || 0)
  if (!Number.isInteger(value) || value <= 0) throw new Error('用户身份无效')
  return value
}

function profile(ctx: Context): string {
  return String(ctx.state.profile?.name || ctx.request.body?.profile || 'default').trim() || 'default'
}

export async function state(ctx: Context): Promise<void> {
  ctx.body = await fnosBrowserManager.getState(userId(ctx), profile(ctx))
}

export async function navigate(ctx: Context): Promise<void> {
  ctx.body = await fnosBrowserManager.navigate(userId(ctx), profile(ctx), ctx.request.body?.url)
}

export async function action(ctx: Context): Promise<void> {
  ctx.body = await fnosBrowserManager.action(userId(ctx), profile(ctx), ctx.request.body?.action)
}

export async function close(ctx: Context): Promise<void> {
  await fnosBrowserManager.close(userId(ctx), profile(ctx))
  ctx.body = { ok: true }
}

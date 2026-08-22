import type { Context } from 'koa'
import {
  fnosBrowserConfigStore,
  type FnosBrowserProfileCreateInput,
  type FnosBrowserProfileUpdateInput,
} from '../../services/hermes/fnos-browser-config'

function body(ctx: Context): Record<string, unknown> {
  return (ctx.request.body && typeof ctx.request.body === 'object') ? ctx.request.body as Record<string, unknown> : {}
}

export async function state(ctx: Context): Promise<void> {
  ctx.body = await fnosBrowserConfigStore.state()
}

export async function create(ctx: Context): Promise<void> {
  ctx.body = await fnosBrowserConfigStore.create(body(ctx) as unknown as FnosBrowserProfileCreateInput)
}

export async function update(ctx: Context): Promise<void> {
  ctx.body = await fnosBrowserConfigStore.update(String(ctx.params.profileId || ''), body(ctx) as unknown as FnosBrowserProfileUpdateInput)
}

export async function activate(ctx: Context): Promise<void> {
  ctx.body = await fnosBrowserConfigStore.activate(String(body(ctx).profileId || ''))
}

export async function remove(ctx: Context): Promise<void> {
  ctx.body = await fnosBrowserConfigStore.delete(String(ctx.params.profileId || ''))
}

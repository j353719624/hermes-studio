import type { IncomingMessage } from 'node:http'
import type { Middleware } from 'koa'
import { config, stripPublicBasePath } from '../config'

const DISABLED_API_PREFIXES = [
  '/api/hermes/update',
  '/api/hermes/runtime-versions',
  '/api/hermes/stt/local-model',
  '/api/hermes/stt/local-stream',
]

function requestedLocalStt(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false
  const value = body as { provider?: unknown; activeProvider?: unknown }
  return value.provider === 'local' || value.activeProvider === 'local'
}

export function isFnosFeatureDisabled(path: string, body?: unknown): boolean {
  if (DISABLED_API_PREFIXES.some(prefix => (
    path === prefix || path.startsWith(`${prefix}/`)
  ))) return true

  if (path === '/api/hermes/stt/settings/local') return true
  return path === '/api/hermes/stt/settings/active' && requestedLocalStt(body)
    || path.startsWith('/api/hermes/stt/settings/') && requestedLocalStt(body)
}

export function isLoopbackAddress(address?: string | null): boolean {
  if (!address) return false
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1'
    || address.startsWith('::ffff:127.')
}

export function isTrimAdminHeader(value: string | string[] | undefined): boolean {
  const normalized = Array.isArray(value) ? value[0] : value
  return ['1', 'true', 'yes'].includes(String(normalized || '').trim().toLowerCase())
}

function requestPath(req: IncomingMessage): string {
  try {
    return new URL(req.url || '/', 'http://fnos.local').pathname
  } catch {
    return '/'
  }
}

export function hasGatewayPrefix(path: string, basePath = config.publicBasePath): boolean {
  return Boolean(basePath && (path === basePath || path.startsWith(`${basePath}/`)))
}

export function isFnosGatewayRequestAllowed(req: IncomingMessage): boolean {
  if (!config.fnos) return true
  if (isLoopbackAddress(req.socket.remoteAddress)) return true
  return hasGatewayPrefix(requestPath(req)) && isTrimAdminHeader(req.headers['x-trim-isadmin'])
}

export function createFnosGatewayMiddleware(): Middleware {
  return async (ctx, next) => {
    if (!config.fnos) {
      await next()
      return
    }

    const path = ctx.path
    const viaGateway = hasGatewayPrefix(path)
    const loopback = isLoopbackAddress(ctx.req.socket.remoteAddress)
    if (!loopback && (!viaGateway || !isTrimAdminHeader(ctx.get('x-trim-isadmin')))) {
      ctx.status = 403
      ctx.body = { error: 'fnos_admin_required' }
      return
    }

    if (viaGateway) {
      const queryIndex = ctx.url.indexOf('?')
      const pathname = queryIndex >= 0 ? ctx.url.slice(0, queryIndex) : ctx.url
      const query = queryIndex >= 0 ? ctx.url.slice(queryIndex) : ''
      ctx.url = `${stripPublicBasePath(pathname, config.publicBasePath)}${query}`
    }

    await next()
  }
}

export function createFnosFeatureGuard(): Middleware {
  return async (ctx, next) => {
    if (config.fnos && isFnosFeatureDisabled(ctx.path, ctx.request.body)) {
      ctx.status = 404
      ctx.body = { error: 'feature_unavailable_on_fnos' }
      return
    }
    await next()
  }
}

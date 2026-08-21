export function getPublicAssetUrl(path: string): string {
  if (/^(?:[a-z]+:|data:|blob:)/i.test(path)) return path
  const base = import.meta.env.BASE_URL || '/'
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

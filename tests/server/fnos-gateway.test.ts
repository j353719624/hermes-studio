import { describe, expect, it } from 'vitest'
import {
  hasGatewayPrefix,
  isFnosFeatureDisabled,
  isTrimAdminHeader,
} from '../../packages/server/src/middleware/fnos-gateway'

describe('fnOS gateway identity', () => {
  it('accepts only explicit administrator values', () => {
    expect(isTrimAdminHeader('true')).toBe(true)
    expect(isTrimAdminHeader('1')).toBe(true)
    expect(isTrimAdminHeader('false')).toBe(false)
    expect(isTrimAdminHeader(undefined)).toBe(false)
  })

  it('matches only the declared public path boundary', () => {
    expect(hasGatewayPrefix('/app/hermes-studio', '/app/hermes-studio')).toBe(true)
    expect(hasGatewayPrefix('/app/hermes-studio/api', '/app/hermes-studio')).toBe(true)
    expect(hasGatewayPrefix('/app/hermes-studio-evil', '/app/hermes-studio')).toBe(false)
  })

  it('blocks update and local STT operations while preserving cloud STT', () => {
    expect(isFnosFeatureDisabled('/api/coding-agents')).toBe(false)
    expect(isFnosFeatureDisabled('/api/coding-agents/codex/install')).toBe(false)
    expect(isFnosFeatureDisabled('/api/app-connections')).toBe(false)
    expect(isFnosFeatureDisabled('/api/devices')).toBe(false)
    expect(isFnosFeatureDisabled('/api/devices/scan')).toBe(false)
    expect(isFnosFeatureDisabled('/api/claude-code-proxy/route/v1/messages')).toBe(false)
    expect(isFnosFeatureDisabled('/api/codex-proxy/route/v1/responses')).toBe(false)
    expect(isFnosFeatureDisabled('/api/hermes/update')).toBe(true)
    expect(isFnosFeatureDisabled('/api/hermes/update/check')).toBe(true)
    expect(isFnosFeatureDisabled('/api/hermes/runtime-versions')).toBe(false)
    expect(isFnosFeatureDisabled('/api/hermes/fnos-runtime')).toBe(false)
    expect(isFnosFeatureDisabled('/api/hermes/fnos-runtime/upgrade')).toBe(false)
    expect(isFnosFeatureDisabled('/api/hermes/terminal')).toBe(false)
    expect(isFnosFeatureDisabled('/api/hermes/stt/local-model/download')).toBe(false)
    expect(isFnosFeatureDisabled('/api/hermes/stt/local-stream/session/chunk')).toBe(false)
    expect(isFnosFeatureDisabled('/api/hermes/stt/settings/local')).toBe(false)
    expect(isFnosFeatureDisabled('/api/hermes/stt/settings/active', { provider: 'local' })).toBe(false)
    expect(isFnosFeatureDisabled('/api/hermes/stt/settings/openai', { activeProvider: 'local' })).toBe(false)
    expect(isFnosFeatureDisabled('/api/hermes/stt/settings/active', { provider: 'openai' })).toBe(false)
    expect(isFnosFeatureDisabled('/api/hermes/stt/transcribe')).toBe(false)
  })
})

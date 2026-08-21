import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  getAppRelayClient,
  startAppRelayClient,
  stopAppRelayClient,
  getDeviceIdentity,
  getPublicSystemInfo,
} = vi.hoisted(() => ({
  getAppRelayClient: vi.fn(() => null),
  startAppRelayClient: vi.fn(() => ({ isPreconnectionExpired: () => false })),
  stopAppRelayClient: vi.fn(),
  getDeviceIdentity: vi.fn(async () => ({
    device_id: 'hwui_machine_1234567890',
    device_public_key: 'public-key',
  })),
  getPublicSystemInfo: vi.fn(async () => ({ computer_name: 'fnOS' })),
}))

vi.mock('../../packages/server/src/services/app-relay/client', () => ({
  getAppRelayClient,
  startAppRelayClient,
  stopAppRelayClient,
}))
vi.mock('../../packages/server/src/services/system-info', () => ({ getDeviceIdentity, getPublicSystemInfo }))

describe('app relay host connection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.HERMES_WEB_UI_URL = 'http://127.0.0.1:43127'
  })

  it('uses the actual fnOS loopback listener instead of PORT=0', async () => {
    const { ensureAppRelayHostClient } = await import('../../packages/server/src/services/app-relay/connection')

    await ensureAppRelayHostClient()

    expect(startAppRelayClient).toHaveBeenCalledWith(expect.objectContaining({
      localBaseUrl: 'http://127.0.0.1:43127',
      machineInfo: expect.objectContaining({
        http_port: 43127,
        endpoint_kind: 'custom',
      }),
    }))
  })
})

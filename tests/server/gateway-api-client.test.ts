import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GatewayApiClient,
  getOrCreateGatewayApiKey,
} from '../../packages/server/src/services/hermes/gateway-api-client'
import { AgentBridgeClient } from '../../packages/server/src/services/hermes/agent-bridge/client'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('Hermes Gateway API client', () => {
  it('creates and reuses a per-profile API key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hermes-studio-gateway-key-'))
    try {
      const first = getOrCreateGatewayApiKey(dir)
      const second = getOrCreateGatewayApiKey(dir)
      expect(first).toHaveLength(64)
      expect(second).toBe(first)
      expect(readFileSync(join(dir, '.hermes-studio-gateway-api-key'), 'utf8').trim()).toBe(first)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('starts a run with bearer auth and the Gateway request shape', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ run_id: 'run-1', status: 'queued' }), { status: 202 }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new GatewayApiClient({
      baseUrl: 'http://127.0.0.1:8642',
      profile: 'default',
      apiKey: 'gateway-test-key-123456',
    })

    await expect(client.startRun({
      sessionId: 'session-1',
      input: 'hello',
      conversationHistory: [{ role: 'user', content: 'previous' }],
      instructions: 'be concise',
      model: 'test-model',
      provider: 'test-provider',
      reasoningEffort: 'low',
    })).resolves.toMatchObject({ run_id: 'run-1', status: 'queued' })

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8642/v1/runs',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer gateway-test-key-123456',
          'Content-Type': 'application/json',
        }),
      }),
    )
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(JSON.parse(String(request.body))).toMatchObject({
      input: 'hello',
      session_id: 'session-1',
      model_options: { reasoning_effort: 'low' },
    })
  })

  it('parses Gateway SSE events', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      'event: message.delta\ndata: {"delta":"Hello"}\n\n'
      + 'event: run.completed\ndata: {"output":"Hello"}\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )))
    const client = new GatewayApiClient({
      baseUrl: 'http://127.0.0.1:8642',
      profile: 'default',
      apiKey: 'gateway-test-key-123456',
    })

    const events = []
    for await (const event of client.streamRun('run-1')) events.push(event)
    expect(events).toEqual([
      { event: 'message.delta', data: { delta: 'Hello' } },
      { event: 'run.completed', data: { output: 'Hello' } },
    ])
  })

  it('always routes chat through the Agent Bridge', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const bridge = new AgentBridgeClient({ connectRetryMs: 0 })
    const request = vi.spyOn(bridge, 'request').mockResolvedValue({
      ok: true,
      run_id: 'workflow-bridge-run',
      session_id: 'workflow-session',
      status: 'running',
    })

    await expect(bridge.chat('session-1', 'hello', [], undefined, 'default', { source: 'cli' })).resolves.toMatchObject({
      run_id: 'workflow-bridge-run',
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ action: 'chat', source: 'cli' }))
  })
})

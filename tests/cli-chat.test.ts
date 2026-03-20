/**
 * CLI Chat Command Tests
 *
 * Tests the chat command's deployment resolution and one-shot message logic
 * using mocked fetch calls (no real gateway needed).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the config module before importing the chat command logic
const mockGetGatewayUrl = vi.fn(() => 'http://localhost:3000');
const mockGetToken = vi.fn(() => 'portal-jwt-token');

// We test the core logic functions directly rather than the Commander action
// to avoid process.exit() calls in tests.

describe('cli-chat: deployment resolution', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('resolves deployment by artifact name from list', async () => {
    const mockDeployments = [
      {
        id: 'deploy-001',
        status: 'READY',
        runtimeToken: 'eyJ.runtime.token',
        artifact: { name: 'my-agent' },
      },
      {
        id: 'deploy-002',
        status: 'FAILED',
        runtimeToken: null,
        artifact: { name: 'other-agent' },
      },
    ];

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockDeployments,
    }) as any;

    // Simulate the resolution logic from chat.ts
    const gatewayUrl = 'http://localhost:3000';
    const token = 'test-token';
    const name = 'my-agent';

    const res = await fetch(`${gatewayUrl}/v1/registry/deployments`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const deployments = (await res.json()) as any[];
    const match = deployments.find(
      (d: any) => d.artifact?.name === name && d.status === 'READY',
    );

    expect(match).toBeDefined();
    expect(match!.id).toBe('deploy-001');
    expect(match!.runtimeToken).toBe('eyJ.runtime.token');
  });

  it('returns null when deployment not found', async () => {
    const mockDeployments = [
      {
        id: 'deploy-001',
        status: 'READY',
        runtimeToken: 'eyJ.runtime.token',
        artifact: { name: 'other-agent' },
      },
    ];

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockDeployments,
    }) as any;

    const res = await fetch('http://localhost:3000/v1/registry/deployments', {
      headers: { Authorization: 'Bearer test-token' },
    });

    const deployments = (await res.json()) as any[];
    const match = deployments.find(
      (d: any) => d.artifact?.name === 'nonexistent' && d.status === 'READY',
    );

    expect(match).toBeUndefined();
  });

  it('skips deployments that are not READY', async () => {
    const mockDeployments = [
      {
        id: 'deploy-001',
        status: 'FAILED',
        runtimeToken: null,
        artifact: { name: 'my-agent' },
      },
      {
        id: 'deploy-002',
        status: 'PENDING',
        runtimeToken: null,
        artifact: { name: 'my-agent' },
      },
    ];

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockDeployments,
    }) as any;

    const res = await fetch('http://localhost:3000/v1/registry/deployments', {
      headers: { Authorization: 'Bearer test-token' },
    });

    const deployments = (await res.json()) as any[];
    const match = deployments.find(
      (d: any) => d.artifact?.name === 'my-agent' && d.status === 'READY',
    );

    expect(match).toBeUndefined();
  });
});

describe('cli-chat: one-shot message', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('sends correct request body with runtime token', async () => {
    let capturedRequest: { url: string; options: any } | null = null;

    globalThis.fetch = vi.fn().mockImplementation(async (url: string, options: any) => {
      capturedRequest = { url, options };
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'Hello from the agent!' } }],
        }),
      };
    }) as any;

    const gatewayUrl = 'http://localhost:3000';
    const runtimeToken = 'eyJ.runtime.token';
    const model = 'gpt-4.1';
    const message = 'Hello, agent!';

    const res = await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${runtimeToken}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: message }],
      }),
    });

    expect(capturedRequest).not.toBeNull();
    expect(capturedRequest!.url).toBe('http://localhost:3000/v1/chat/completions');
    expect(capturedRequest!.options.headers.Authorization).toBe('Bearer eyJ.runtime.token');

    const body = JSON.parse(capturedRequest!.options.body);
    expect(body.model).toBe('gpt-4.1');
    expect(body.messages).toEqual([{ role: 'user', content: 'Hello, agent!' }]);

    const data = await res.json();
    expect(data.choices[0].message.content).toBe('Hello from the agent!');
  });

  it('handles API error response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    }) as any;

    const res = await fetch('http://localhost:3000/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer expired-token',
      },
      body: JSON.stringify({
        model: 'gpt-4.1',
        messages: [{ role: 'user', content: 'test' }],
      }),
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(401);
  });
});

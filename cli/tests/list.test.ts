import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('list command', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('displays deployments in a formatted table', async () => {
    vi.mock('../src/config.js', () => ({
      getGatewayUrl: () => 'http://localhost:3000',
      getToken: () => 'test-token',
    }));

    const deployments = [
      {
        id: 'deploy-1',
        name: 'my-agent-production',
        environment: 'production',
        status: 'READY',
        deployedAt: '2026-03-20T10:00:00.000Z',
        artifact: { name: 'my-agent' },
      },
      {
        id: 'deploy-2',
        name: 'my-kb-staging',
        environment: 'staging',
        status: 'PENDING',
        deployedAt: null,
        artifact: { name: 'my-kb' },
      },
    ];

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify(deployments), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { listCommand } = await import('../src/commands/list.js');
    await listCommand.parseAsync(['node', 'list']);

    expect(consoleSpy).toHaveBeenCalled();
    // Header row
    const headerCall = consoleSpy.mock.calls[0][0] as string;
    expect(headerCall).toContain('NAME');
    expect(headerCall).toContain('ARTIFACT');
    expect(headerCall).toContain('ENV');
    expect(headerCall).toContain('STATUS');
    expect(headerCall).toContain('DEPLOYED');

    // Data row
    const firstRow = consoleSpy.mock.calls[1][0] as string;
    expect(firstRow).toContain('my-agent-production');
    expect(firstRow).toContain('my-agent');
    expect(firstRow).toContain('production');
    expect(firstRow).toContain('READY');
  });

  it('displays message when no deployments exist', async () => {
    vi.mock('../src/config.js', () => ({
      getGatewayUrl: () => 'http://localhost:3000',
      getToken: () => 'test-token',
    }));

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { listCommand } = await import('../src/commands/list.js');
    await listCommand.parseAsync(['node', 'list']);

    expect(consoleSpy).toHaveBeenCalledWith('No deployments found.');
  });
});

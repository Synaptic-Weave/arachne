/**
 * Beta signup endpoint tests
 *
 * Tests POST /v1/beta/signup (public endpoint, no auth required).
 * Mocks orm.em.fork() to simulate persistAndFlush behavior and unique constraint violations.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { UniqueConstraintViolationException } from '@mikro-orm/core';

const { mockPersistAndFlush, mockFindOne, mockEm } = vi.hoisted(() => {
  const mockPersistAndFlush = vi.fn();
  const mockFindOne = vi.fn();
  const mockEm = {
    persistAndFlush: mockPersistAndFlush,
    findOne: mockFindOne,
  };
  return { mockPersistAndFlush, mockFindOne, mockEm };
});

// Mock AdminService for signups-enabled endpoint
vi.mock('../src/application/services/AdminService.js', () => ({
  AdminService: vi.fn().mockImplementation(() => ({
    getSettings: vi.fn().mockResolvedValue({ signupsEnabled: true }),
  })),
}));

import { registerBetaRoutes } from '../src/routes/beta.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  // Per-request EM forking (simulated for tests)
  app.decorateRequest('em', null as any);
  app.addHook('onRequest', async (request) => {
    request.em = mockEm as any;
  });
  registerBetaRoutes(app);
  await app.ready();
  return app;
}

describe('POST /v1/beta/signup', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
    mockPersistAndFlush.mockClear();
    mockFindOne.mockClear();
    mockFindOne.mockResolvedValue(null); // Default: no existing user
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 201 with status:registered for valid email and name', async () => {
    mockPersistAndFlush.mockResolvedValueOnce(undefined);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/beta/signup',
      payload: { email: 'user@example.com', name: 'John Doe' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ status: string; message: string }>();
    expect(body.status).toBe('registered');
    expect(body.message).toContain("You're on the list");
    expect(mockPersistAndFlush).toHaveBeenCalledTimes(1);
  });

  it('returns 201 with status:registered when name is omitted (optional)', async () => {
    mockPersistAndFlush.mockResolvedValueOnce(undefined);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/beta/signup',
      payload: { email: 'user@example.com' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ status: string }>();
    expect(body.status).toBe('registered');
    expect(mockPersistAndFlush).toHaveBeenCalledTimes(1);
  });

  it('returns 200 with status:registered on duplicate email (23505)', async () => {
    mockPersistAndFlush.mockRejectedValueOnce(new UniqueConstraintViolationException(new Error('duplicate key')));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/beta/signup',
      payload: { email: 'existing@example.com', name: 'Jane Smith' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string }>();
    expect(body.status).toBe('registered'); // Returns same message to avoid information disclosure
  });

  it('returns 400 when email is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/beta/signup',
      payload: { name: 'John Doe' },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: string }>();
    expect(body.error).toBe('Valid email is required');
    expect(mockPersistAndFlush).not.toHaveBeenCalled();
  });

  it('returns 400 when email is not a string', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/beta/signup',
      payload: { email: 12345 },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: string }>();
    expect(body.error).toBe('Valid email is required');
  });

  it('returns 400 for invalid email format', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/beta/signup',
      payload: { email: 'notanemail' },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: string }>();
    expect(body.error).toBe('Valid email is required');
  });

  it('normalizes email to lowercase (no leading/trailing spaces)', async () => {
    mockPersistAndFlush.mockResolvedValueOnce(undefined);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/beta/signup',
      payload: { email: 'TEST@EXAMPLE.COM', name: 'Test User' },
    });

    expect(res.statusCode).toBe(201);
    const entity = mockPersistAndFlush.mock.calls[0][0];
    expect(entity.email).toBe('test@example.com');
  });

  it('returns 400 when body is empty', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/beta/signup',
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: string }>();
    expect(body.error).toBe('Valid email is required');
  });

  it('returns 400 for email with leading/trailing whitespace', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/beta/signup',
      payload: { email: '  user@example.com  ' },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: string }>();
    expect(body.error).toBe('Valid email is required');
  });

  it('returns 500 on unexpected database error', async () => {
    mockPersistAndFlush.mockRejectedValue(new Error('Connection refused'));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/beta/signup',
      payload: { email: 'test@example.com' },
    });

    expect(res.statusCode).toBe(500);
    const body = res.json<{ error: string }>();
    expect(body.error).toBe('Signup failed');
  });
});

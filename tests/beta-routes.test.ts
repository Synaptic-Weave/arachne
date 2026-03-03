/**
 * Beta signup endpoint tests
 *
 * Tests POST /v1/beta/signup (public endpoint, no auth required).
 * Mocks query() from src/db.js to simulate INSERT behavior and unique constraint violations.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

vi.mock('../src/db.js', () => ({
  query: vi.fn(),
}));

import { registerBetaRoutes } from '../src/routes/beta.js';
import { query } from '../src/db.js';

const mockQuery = query as ReturnType<typeof vi.fn>;

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerBetaRoutes(app);
  await app.ready();
  return app;
}

describe('POST /v1/beta/signup', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
    mockQuery.mockClear();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 201 with status:registered for valid email and name', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/beta/signup',
      payload: { email: 'user@example.com', name: 'John Doe' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ status: string; message: string }>();
    expect(body.status).toBe('registered');
    expect(body.message).toContain("You're on the list");

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery).toHaveBeenCalledWith(
      'INSERT INTO beta_signups (email, name) VALUES ($1, $2)',
      ['user@example.com', 'John Doe']
    );
  });

  it('returns 201 with status:registered when name is omitted (optional)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/beta/signup',
      payload: { email: 'user@example.com' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ status: string }>();
    expect(body.status).toBe('registered');

    expect(mockQuery).toHaveBeenCalledWith(
      'INSERT INTO beta_signups (email, name) VALUES ($1, $2)',
      ['user@example.com', null]
    );
  });

  it('returns 200 with status:already_registered on duplicate email (23505)', async () => {
    const err: any = new Error('duplicate key value violates unique constraint');
    err.code = '23505';
    mockQuery.mockRejectedValueOnce(err);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/beta/signup',
      payload: { email: 'existing@example.com', name: 'Jane Smith' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string }>();
    expect(body.status).toBe('already_registered');
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

    expect(mockQuery).not.toHaveBeenCalled();
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
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/beta/signup',
      payload: { email: 'TEST@EXAMPLE.COM', name: 'Test User' },
    });

    expect(res.statusCode).toBe(201);
    expect(mockQuery).toHaveBeenCalledWith(
      'INSERT INTO beta_signups (email, name) VALUES ($1, $2)',
      ['test@example.com', 'Test User']
    );
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
    const err = new Error('Connection refused');
    mockQuery.mockRejectedValue(err);

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

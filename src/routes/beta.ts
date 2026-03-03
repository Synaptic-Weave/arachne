import type { FastifyInstance } from 'fastify';
import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { orm } from '../orm.js';
import { BetaSignup } from '../domain/entities/BetaSignup.js';

export function registerBetaRoutes(fastify: FastifyInstance): void {
  // ── POST /v1/beta/signup ──────────────────────────────────────────────────
  // Public endpoint — no auth required.
  fastify.post<{
    Body: { email: string; name?: string };
  }>('/v1/beta/signup', async (request, reply) => {
    const { email, name } = request.body ?? {};

    if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return reply.code(400).send({ error: 'Valid email is required' });
    }

    const em = orm.em.fork();
    try {
      const signup = new BetaSignup(email.toLowerCase().trim(), name);
      await em.persistAndFlush(signup);
      return reply.code(201).send({
        status: 'registered',
        message: "You're on the list! We'll be in touch.",
      });
    } catch (err: any) {
      if (err instanceof UniqueConstraintViolationException) {
        return reply.code(200).send({ status: 'already_registered' });
      }
      fastify.log.error({ err }, 'beta/signup insert failed');
      return reply.code(500).send({ error: 'Signup failed' });
    }
  });
}


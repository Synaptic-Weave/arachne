import type { FastifyInstance } from 'fastify';
import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { orm } from '../orm.js';
import { BetaSignup } from '../domain/entities/BetaSignup.js';
import { User } from '../domain/entities/User.js';
import { AdminService } from '../application/services/AdminService.js';

export function registerBetaRoutes(fastify: FastifyInstance): void {
  const adminService = new AdminService(orm.em);

  // ── GET /v1/beta/signups-enabled ──────────────────────────────────────────
  // Public endpoint to check if self-service signups are enabled
  fastify.get('/v1/beta/signups-enabled', async (request, reply) => {
    try {
      const settings = await adminService.getSettings();
      return reply.send({ signupsEnabled: settings.signupsEnabled });
    } catch (err) {
      fastify.log.error({ err }, 'Failed to fetch signup settings');
      // Default to disabled if we can't fetch settings
      return reply.send({ signupsEnabled: false });
    }
  });

  // ── POST /v1/beta/signup ──────────────────────────────────────────────────
  // Public endpoint — no auth required.
  fastify.post<{
    Body: { email: string; name?: string };
  }>('/v1/beta/signup', async (request, reply) => {
    const { email, name } = request.body ?? {};

    if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return reply.code(400).send({ error: 'Valid email is required' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const em = orm.em.fork();

    // Check if email already exists as a registered user
    // Return same success message to avoid information disclosure
    const existingUser = await em.findOne(User, { email: normalizedEmail });
    if (existingUser) {
      fastify.log.info({ email: normalizedEmail }, 'Beta signup attempt for existing user email');
      return reply.code(200).send({
        status: 'registered',
        message: "You're on the list! We'll be in touch.",
      });
    }

    try {
      const signup = new BetaSignup(normalizedEmail, name);
      await em.persistAndFlush(signup);
      return reply.code(201).send({
        status: 'registered',
        message: "You're on the list! We'll be in touch.",
      });
    } catch (err: any) {
      if (err instanceof UniqueConstraintViolationException) {
        // Duplicate beta signup (not a user, just duplicate beta entry)
        return reply.code(200).send({
          status: 'registered',
          message: "You're on the list! We'll be in touch.",
        });
      }
      fastify.log.error({ err }, 'beta/signup insert failed');
      return reply.code(500).send({ error: 'Signup failed' });
    }
  });
}


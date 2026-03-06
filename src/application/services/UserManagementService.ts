import { promisify } from 'node:util';
import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { signJwt } from '../../auth/jwtUtils.js';
import { TENANT_OWNER_SCOPES } from '../../auth/registryScopes.js';
import type { EntityManager } from '@mikro-orm/core';
import { User } from '../../domain/entities/User.js';
import { Tenant } from '../../domain/entities/Tenant.js';
import { TenantMembership } from '../../domain/entities/TenantMembership.js';
import { Invite } from '../../domain/entities/Invite.js';
import { BetaSignup } from '../../domain/entities/BetaSignup.js';
import type { CreateUserDto, LoginDto, AcceptInviteDto, AuthResult } from '../dtos/index.js';
import { generateOrgSlug } from '../../utils/slug.js';

const scryptAsync = promisify(scrypt);

const PORTAL_JWT_SECRET =
  process.env.PORTAL_JWT_SECRET ?? 'unsafe-portal-secret-change-in-production';

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const derivedKey = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${salt}:${derivedKey.toString('hex')}`;
}

async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [salt, key] = storedHash.split(':');
  const derivedKey = (await scryptAsync(password, salt, 64)) as Buffer;
  const storedKey = Buffer.from(key, 'hex');
  return derivedKey.length === storedKey.length && timingSafeEqual(derivedKey, storedKey);
}

export class UserManagementService {
  constructor(private readonly em: EntityManager) {}

  private createUserWithTenant(email: string, passwordHash: string, tenantName?: string): { user: User; tenant: Tenant } {
    const user = new User(email, passwordHash);
    const tenant = new Tenant(user, tenantName ?? `${email.split('@')[0]}'s Workspace`);
    tenant.createAgent('Default');
    return { user, tenant };
  }

  private async assignUniqueSlug(tenant: Tenant): Promise<void> {
    const base = generateOrgSlug(tenant.name);
    let candidate = base;
    let suffix = 2;
    while (await this.em.findOne(Tenant, { orgSlug: candidate })) {
      candidate = `${base.slice(0, 47)}-${suffix}`;
      suffix++;
    }
    tenant.orgSlug = candidate;
  }

  async createUser(dto: CreateUserDto): Promise<AuthResult> {
    if (!dto.email || !dto.password || dto.password.length < 8) {
      throw new Error('Valid email and password (min 8 chars) required');
    }

    // Email uniqueness pre-check
    const existingUser = await this.em.findOne(User, { email: dto.email.toLowerCase() });
    if (existingUser) {
      throw Object.assign(new Error('Email already registered'), { status: 409 });
    }

    const passwordHash = await hashPassword(dto.password);
    const normalizedEmail = dto.email.toLowerCase();
    const tenantName = dto.tenantName?.trim() || undefined;

    const { user, tenant } = this.createUserWithTenant(normalizedEmail, passwordHash, tenantName);

    this.em.persist(user);
    this.em.persist(tenant);
    await this.assignUniqueSlug(tenant);
    await this.em.flush();

    const token = signJwt({ sub: user.id, tenantId: tenant.id, role: 'owner', scopes: TENANT_OWNER_SCOPES, orgSlug: tenant.orgSlug ?? null }, PORTAL_JWT_SECRET, 86_400_000);
    return { token, userId: user.id, tenantId: tenant.id, email: user.email, tenantName: tenant.name };
  }

  async login(dto: LoginDto): Promise<AuthResult> {
    if (!dto.email || !dto.password) {
      throw new Error('Email and password required');
    }

    const user = await this.em.findOne(User, { email: dto.email.toLowerCase() });
    if (!user) throw new Error('Invalid credentials');

    const valid = await verifyPassword(dto.password, user.passwordHash);
    if (!valid) throw new Error('Invalid credentials');

    user.lastLogin = new Date();
    await this.em.flush();

    // Load all tenant memberships for the user
    const memberships = await this.em.find(
      TenantMembership,
      { user: user.id },
      { populate: ['tenant'], orderBy: { joinedAt: 'ASC' } },
    );

    // Filter to only active tenants
    const activeMemberships = memberships.filter(
      (m) => (m.tenant as Tenant).status === 'active'
    );

    if (activeMemberships.length === 0) {
      throw Object.assign(new Error('No active tenant memberships'), { status: 403 });
    }

    // Primary tenant is the first active membership
    const primaryMembership = activeMemberships[0];
    const tenantId = (primaryMembership.tenant as any)?.id ?? '';
    const tenantName = (primaryMembership.tenant as any)?.name ?? '';

    // Build tenants list for response
    const tenants = activeMemberships.map((m) => ({
      id: (m.tenant as any)?.id ?? '',
      name: (m.tenant as any)?.name ?? '',
      role: m.role,
    }));

    const scopes = primaryMembership.role === 'owner' ? TENANT_OWNER_SCOPES : [];
    const token = signJwt({ sub: user.id, tenantId, role: primaryMembership.role, scopes, orgSlug: (primaryMembership.tenant as Tenant).orgSlug ?? null }, PORTAL_JWT_SECRET, 86_400_000);
    return { token, userId: user.id, tenantId, email: user.email, tenantName, tenants };
  }

  async acceptInvite(dto: AcceptInviteDto): Promise<AuthResult> {
    if (!dto.password || dto.password.length < 8) {
      throw new Error('Password must be at least 8 characters');
    }

    // First check if this is a beta signup invite code
    const betaSignup = await this.em.findOne(BetaSignup, { inviteCode: dto.inviteToken });

    if (betaSignup) {
      // Handle beta invite signup (creates new tenant like self-service signup)
      if (!betaSignup.approvedAt || !betaSignup.inviteCode) {
        throw new Error('Beta invite has not been approved');
      }
      if (betaSignup.inviteUsedAt) {
        throw new Error('Beta invite has already been used');
      }
      if (betaSignup.email.toLowerCase() !== dto.email.toLowerCase()) {
        throw new Error('Email does not match beta signup');
      }

      const normalizedEmail = dto.email.toLowerCase();

      // Check if user already exists with this email
      const existingUser = await this.em.findOne(User, { email: normalizedEmail });
      if (existingUser) {
        throw Object.assign(
          new Error('This email is already registered. Please sign in instead.'),
          { status: 409 }
        );
      }

      // Create user and tenant (similar to createUser flow)
      const passwordHash = await hashPassword(dto.password);
      const { user, tenant } = this.createUserWithTenant(normalizedEmail, passwordHash);

      // Set tenant name from email domain or default
      tenant.name = normalizedEmail.split('@')[0] + "'s Org";

      this.em.persist(user);
      this.em.persist(tenant);
      await this.assignUniqueSlug(tenant);

      // Mark beta signup as used
      betaSignup.markAsUsed();

      await this.em.flush();

      const token = signJwt({ sub: user.id, tenantId: tenant.id, role: 'owner', scopes: TENANT_OWNER_SCOPES, orgSlug: tenant.orgSlug ?? null }, PORTAL_JWT_SECRET, 86_400_000);
      return {
        token,
        userId: user.id,
        tenantId: tenant.id,
        email: user.email,
        tenantName: tenant.name,
      };
    }

    // Otherwise, check for tenant invite
    const invite = await this.em.findOne(
      Invite,
      { token: dto.inviteToken },
      { populate: ['tenant'] },
    );

    if (!invite) throw new Error('Invalid invite token');
    if (invite.expiresAt < new Date()) throw new Error('Invite has expired');
    if (invite.revokedAt) throw new Error('Invite has been revoked');
    if (invite.maxUses !== null && invite.useCount >= invite.maxUses) {
      throw new Error('Invite has reached max uses');
    }

    const tenant = invite.tenant as Tenant;

    // Check tenant status
    if (tenant.status !== 'active') {
      throw Object.assign(new Error('Tenant is not active'), { status: 400 });
    }

    let user = await this.em.findOne(User, { email: dto.email.toLowerCase() });
    let role = 'member';

    if (!user) {
      const passwordHash = await hashPassword(dto.password);
      const normalizedEmail = dto.email.toLowerCase();
      const { user: newUser, tenant: personalTenant } = this.createUserWithTenant(normalizedEmail, passwordHash);
      user = newUser;
      this.em.persist(user);
      this.em.persist(personalTenant);
      await this.assignUniqueSlug(personalTenant);
    }

    // Check for existing membership
    const existingMembership = await this.em.findOne(TenantMembership, {
      user: user.id,
      tenant: tenant.id,
    });

    if (existingMembership) {
      throw Object.assign(new Error('Already a member of this tenant'), { status: 409 });
    }

    tenant.addMembership(user, role);

    invite.useCount += 1;
    await this.em.flush();

    const inviteScopes = role === 'owner' ? TENANT_OWNER_SCOPES : [];
    const token = signJwt({ sub: user.id, tenantId: tenant.id, role, scopes: inviteScopes, orgSlug: tenant.orgSlug ?? null }, PORTAL_JWT_SECRET, 86_400_000);
    return {
      token,
      userId: user.id,
      tenantId: tenant.id,
      email: user.email,
      tenantName: tenant.name,
    };
  }

  async switchTenant(userId: string, newTenantId: string): Promise<AuthResult> {
    const user = await this.em.findOneOrFail(User, { id: userId });
    
    const membership = await this.em.findOne(
      TenantMembership,
      { user: userId, tenant: newTenantId },
      { populate: ['tenant'] },
    );

    if (!membership) {
      throw Object.assign(new Error('No membership in requested tenant'), { status: 403 });
    }

    const tenant = membership.tenant as Tenant;
    if (tenant.status !== 'active') {
      throw Object.assign(new Error('Tenant is not active'), { status: 400 });
    }

    // Load all active tenant memberships
    const allMemberships = await this.em.find(
      TenantMembership,
      { user: userId },
      { populate: ['tenant'] },
    );

    const activeMemberships = allMemberships.filter(
      (m) => (m.tenant as Tenant).status === 'active'
    );

    const tenants = activeMemberships.map((m) => ({
      id: (m.tenant as any)?.id ?? '',
      name: (m.tenant as any)?.name ?? '',
      role: m.role,
    }));

    const switchScopes = membership.role === 'owner' ? TENANT_OWNER_SCOPES : [];
    const token = signJwt({ sub: userId, tenantId: newTenantId, role: membership.role, scopes: switchScopes, orgSlug: tenant.orgSlug ?? null }, PORTAL_JWT_SECRET, 86_400_000);
    return {
      token,
      userId: user.id,
      tenantId: newTenantId,
      email: user.email,
      tenantName: tenant.name,
      tenants,
    };
  }

  async leaveTenant(userId: string, tenantId: string, currentTenantId: string): Promise<void> {
    // Prevent leaving currently active tenant
    if (tenantId === currentTenantId) {
      throw Object.assign(new Error('Switch to a different tenant before leaving'), { status: 400 });
    }

    const membership = await this.em.findOne(TenantMembership, {
      user: userId,
      tenant: tenantId,
    });

    if (!membership) {
      throw Object.assign(new Error('Membership not found'), { status: 404 });
    }

    // Check if user is the last owner
    if (membership.role === 'owner') {
      const ownerCount = await this.em.count(TenantMembership, {
        tenant: tenantId,
        role: 'owner',
      });

      if (ownerCount === 1) {
        throw Object.assign(new Error('Cannot leave tenant as the last owner'), { status: 400 });
      }
    }

    await this.em.removeAndFlush(membership);
  }
}

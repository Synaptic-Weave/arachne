import { randomUUID } from 'node:crypto';
import { Collection } from '@mikro-orm/core';
import { Agent } from './Agent.js';
import { TenantMembership } from './TenantMembership.js';
import { Invite } from './Invite.js';
import type { User } from './User.js';

export class Tenant {
  id!: string;
  name!: string;
  orgSlug?: string | null;
  parentId!: string | null;
  providerConfig!: any | null;
  systemPrompt!: string | null;
  skills!: any[] | null;
  mcpEndpoints!: any[] | null;
  defaultProviderId!: string | null;
  status!: string;
  availableModels!: any[] | null;
  updatedAt!: Date;
  createdAt!: Date;

  agents = new Collection<Agent>(this);
  members = new Collection<TenantMembership>(this);
  invites = new Collection<Invite>(this);

  constructor(owner: User, name: string) {
    this.id = randomUUID();
    this.name = name;
    this.parentId = null;
    this.providerConfig = null;
    this.systemPrompt = null;
    this.skills = null;
    this.mcpEndpoints = null;
    this.defaultProviderId = null;
    this.status = 'active';
    this.availableModels = null;
    this.updatedAt = new Date();
    this.createdAt = new Date();
    this.addMembership(owner, 'owner');
  }

  createAgent(name: string, config?: Partial<Agent>): Agent {
    const agent = new Agent(this, name, config);
    this.agents.add(agent);
    return agent;
  }

  createInvite(createdBy: User, maxUses?: number, expiresInDays = 7): Invite {
    const invite = new Invite(this, createdBy, maxUses ?? null, expiresInDays);
    this.invites.add(invite);
    return invite;
  }

  addMembership(user: User, role: string): TenantMembership {
    const membership = new TenantMembership(this, user, role);
    this.members.add(membership);
    return membership;
  }

  createSubtenant(name: string): Tenant {
    const ownerMembership = this.members.find(m => m.role === 'owner');
    if (!ownerMembership) throw new Error('Cannot create subtenant: parent tenant has no owner member');
    const child = new Tenant(ownerMembership.user, name);
    child.parentId = this.id;
    for (const m of this.members) {
      if (m.user !== ownerMembership.user) {
        child.addMembership(m.user, m.role);
      }
    }
    return child;
  }
}

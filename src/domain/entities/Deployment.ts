import { randomUUID } from 'node:crypto';
import type { Tenant } from './Tenant.js';
import type { Artifact } from './Artifact.js';

export type DeploymentStatus = 'PENDING' | 'READY' | 'FAILED';

/**
 * 🩷 Moment-Interval archetype
 * A deployment event that provisions an artifact into a runtime environment.
 * Tracks lifecycle from pending through ready/failed.
 */
export class Deployment {
  id!: string;
  tenant!: Tenant;
  artifact!: Artifact;
  environment!: string;
  name!: string;
  status!: DeploymentStatus;
  tokenVersion!: number;
  runtimeToken!: string | null;
  errorMessage!: string | null;
  deployedAt!: Date | null;
  createdAt!: Date;
  updatedAt!: Date;

  constructor(
    tenant: Tenant,
    artifact: Artifact,
    environment: string = 'production',
    name?: string,
  ) {
    this.id = randomUUID();
    this.tenant = tenant;
    this.artifact = artifact;
    this.environment = environment;
    this.name = name ?? `${(artifact as any).name}-${environment}`;
    this.status = 'PENDING';
    this.tokenVersion = 1;
    this.runtimeToken = null;
    this.errorMessage = null;
    this.deployedAt = null;
    this.createdAt = new Date();
    this.updatedAt = new Date();
  }

  markReady(runtimeToken: string): void {
    this.status = 'READY';
    this.runtimeToken = runtimeToken;
    this.deployedAt = new Date();
    this.updatedAt = new Date();
  }

  markFailed(errorMessage: string): void {
    this.status = 'FAILED';
    this.errorMessage = errorMessage;
    this.updatedAt = new Date();
  }
}

import { EntitySchema } from '@mikro-orm/core';
import { Deployment } from '../entities/Deployment.js';
import { Tenant } from '../entities/Tenant.js';
import { Artifact } from '../entities/Artifact.js';

export const DeploymentSchema = new EntitySchema<Deployment>({
  class: Deployment,
  tableName: 'deployments',
  properties: {
    id: { type: 'uuid', primary: true },
    tenant: { kind: 'm:1', entity: () => Tenant, fieldName: 'tenant_id' },
    artifact: { kind: 'm:1', entity: () => Artifact, fieldName: 'artifact_id' },
    environment: { type: 'string', columnType: 'varchar(50)', default: 'production' },
    name: { type: 'string', columnType: 'varchar(200)' },
    status: { type: 'string', columnType: 'varchar(50)', default: 'PENDING' },
    tokenVersion: { type: 'number', fieldName: 'token_version', default: 1 },
    runtimeToken: { type: 'text', fieldName: 'runtime_token', nullable: true },
    errorMessage: { type: 'text', fieldName: 'error_message', nullable: true },
    deployedAt: { type: 'Date', fieldName: 'deployed_at', nullable: true },
    createdAt: { type: 'Date', fieldName: 'created_at', onCreate: () => new Date() },
    updatedAt: { type: 'Date', fieldName: 'updated_at', onCreate: () => new Date(), onUpdate: () => new Date() },
  },
});

export const REGISTRY_SCOPES = {
  WEAVE_WRITE: 'weave:write',
  REGISTRY_PUSH: 'registry:push',
  DEPLOY_WRITE: 'deploy:write',
  ARTIFACT_READ: 'artifact:read',
  RUNTIME_ACCESS: 'runtime:access',
} as const;

export type RegistryScope = typeof REGISTRY_SCOPES[keyof typeof REGISTRY_SCOPES];

// Scopes automatically granted to tenant owners
export const TENANT_OWNER_SCOPES: RegistryScope[] = [
  REGISTRY_SCOPES.WEAVE_WRITE,
  REGISTRY_SCOPES.REGISTRY_PUSH,
  REGISTRY_SCOPES.DEPLOY_WRITE,
  REGISTRY_SCOPES.ARTIFACT_READ,
];

// Scopes automatically granted to tenant members (non-owners)
export const TENANT_MEMBER_SCOPES: RegistryScope[] = [
  REGISTRY_SCOPES.ARTIFACT_READ,
];

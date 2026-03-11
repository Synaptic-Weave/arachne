# STI Refactor + Story 2 Implementation Plan

**Date:** 2026-03-06
**Status:** Approved for Implementation

---

## Overview

Refactor Story 1's Provider entity to use MikroORM Single Table Inheritance (STI), then implement Story 2 (Gateway Provider Management).

## Decision: Single Table Inheritance (STI)

**Rationale:**
- ORM returns correct implementation automatically
- Polymorphic methods (validate(), createClient()) are type-safe
- No helper classes needed
- Clean separation of provider-specific logic
- Existing migration already has `type` discriminator column

**Alternative Rejected:** Dynamic attributes table (EAV pattern) - over-engineering for 3 provider types

---

## Part 1: Refactor Story 1 for STI

### 1.1 Create ProviderBase Entity

**File:** `src/domain/entities/ProviderBase.ts`

```typescript
import { randomUUID } from 'node:crypto';
import type { Tenant } from './Tenant.js';

export abstract class ProviderBase {
  id!: string;
  name!: string;
  description!: string | null;

  // Scoping: null = gateway provider, uuid = tenant provider
  tenant!: Tenant | null;

  // Gateway default flag
  isDefault!: boolean;

  // Configuration (encrypted)
  apiKey!: string;

  // Model restrictions
  availableModels!: string[];

  createdAt!: Date;
  updatedAt!: Date | null;

  constructor(
    name: string,
    apiKey: string,
    config?: {
      description?: string;
      tenant?: Tenant;
      isDefault?: boolean;
      availableModels?: string[];
    }
  ) {
    this.id = randomUUID();
    this.name = name;
    this.description = config?.description ?? null;
    this.tenant = config?.tenant ?? null;
    this.isDefault = config?.isDefault ?? false;
    this.apiKey = apiKey;
    this.availableModels = config?.availableModels ?? [];
    this.createdAt = new Date();
    this.updatedAt = null;
  }

  /**
   * Check if this is a gateway provider
   */
  isGatewayProvider(): boolean {
    return this.tenant === null;
  }

  /**
   * Abstract methods - implemented by concrete providers
   */
  abstract validate(): void;
  abstract createClient(): any; // LLMClient type
  abstract sanitizeForTenant(): Partial<ProviderBase>;
}
```

### 1.2 Create OpenAIProvider Entity

**File:** `src/domain/entities/OpenAIProvider.ts`

```typescript
import { ProviderBase } from './ProviderBase.js';

export class OpenAIProvider extends ProviderBase {
  baseUrl!: string | null;

  validate(): void {
    if (!this.apiKey) {
      throw new Error('API key is required for OpenAI provider');
    }
  }

  createClient(): any {
    // TODO: Implement OpenAI client creation
    // return new OpenAI({
    //   apiKey: decrypt(this.apiKey),
    //   baseURL: this.baseUrl ?? undefined,
    // });
    throw new Error('Not implemented');
  }

  sanitizeForTenant(): Partial<OpenAIProvider> {
    if (this.isGatewayProvider()) {
      return {
        id: this.id,
        name: this.name,
        description: this.description,
        isDefault: this.isDefault,
        availableModels: this.availableModels,
        createdAt: this.createdAt,
        updatedAt: this.updatedAt,
        // EXCLUDE: apiKey, baseUrl
      };
    }
    return this;
  }
}
```

### 1.3 Create AzureProvider Entity

**File:** `src/domain/entities/AzureProvider.ts`

```typescript
import { ProviderBase } from './ProviderBase.js';

export class AzureProvider extends ProviderBase {
  baseUrl!: string | null;
  deployment!: string;
  apiVersion!: string;

  validate(): void {
    if (!this.apiKey) {
      throw new Error('API key is required for Azure provider');
    }
    if (!this.deployment) {
      throw new Error('Deployment is required for Azure provider');
    }
    if (!this.apiVersion) {
      throw new Error('API version is required for Azure provider');
    }
  }

  createClient(): any {
    // TODO: Implement Azure client creation
    // return new AzureOpenAI({
    //   apiKey: decrypt(this.apiKey),
    //   endpoint: this.baseUrl,
    //   deployment: this.deployment,
    //   apiVersion: this.apiVersion,
    // });
    throw new Error('Not implemented');
  }

  sanitizeForTenant(): Partial<AzureProvider> {
    if (this.isGatewayProvider()) {
      return {
        id: this.id,
        name: this.name,
        description: this.description,
        isDefault: this.isDefault,
        availableModels: this.availableModels,
        createdAt: this.createdAt,
        updatedAt: this.updatedAt,
        // EXCLUDE: apiKey, baseUrl, deployment, apiVersion
      };
    }
    return this;
  }
}
```

### 1.4 Create OllamaProvider Entity

**File:** `src/domain/entities/OllamaProvider.ts`

```typescript
import { ProviderBase } from './ProviderBase.js';

export class OllamaProvider extends ProviderBase {
  baseUrl!: string; // Required for Ollama

  validate(): void {
    if (!this.baseUrl) {
      throw new Error('Base URL is required for Ollama provider');
    }
  }

  createClient(): any {
    // TODO: Implement Ollama client creation
    throw new Error('Not implemented');
  }

  sanitizeForTenant(): Partial<OllamaProvider> {
    if (this.isGatewayProvider()) {
      return {
        id: this.id,
        name: this.name,
        description: this.description,
        isDefault: this.isDefault,
        availableModels: this.availableModels,
        createdAt: this.createdAt,
        updatedAt: this.updatedAt,
        // EXCLUDE: apiKey, baseUrl
      };
    }
    return this;
  }
}
```

### 1.5 Create ProviderBase Schema

**File:** `src/domain/schemas/ProviderBase.schema.ts`

```typescript
import { EntitySchema } from '@mikro-orm/core';
import { ProviderBase } from '../entities/ProviderBase.js';
import { OpenAIProvider } from '../entities/OpenAIProvider.js';
import { AzureProvider } from '../entities/AzureProvider.js';
import { OllamaProvider } from '../entities/OllamaProvider.js';
import { Tenant } from '../entities/Tenant.js';

export const ProviderBaseSchema = new EntitySchema<ProviderBase>({
  class: ProviderBase,
  tableName: 'providers',
  discriminatorColumn: 'type',
  discriminatorMap: {
    openai: 'OpenAIProvider',
    azure: 'AzureProvider',
    ollama: 'OllamaProvider',
  },
  abstract: true,
  properties: {
    id: { type: 'uuid', primary: true },
    name: { type: 'string', columnType: 'varchar(255)' },
    description: { type: 'text', nullable: true },
    tenant: {
      kind: 'm:1',
      entity: () => Tenant,
      fieldName: 'tenant_id',
      nullable: true,
    },
    isDefault: {
      type: 'boolean',
      fieldName: 'is_default',
      default: false,
    },
    apiKey: { type: 'text', fieldName: 'api_key' },
    availableModels: {
      type: 'array',
      fieldName: 'available_models',
      default: [],
    },
    createdAt: {
      type: 'Date',
      fieldName: 'created_at',
      onCreate: () => new Date(),
    },
    updatedAt: {
      type: 'Date',
      fieldName: 'updated_at',
      nullable: true,
      onUpdate: () => new Date(),
    },
  },
});
```

### 1.6 Create OpenAIProvider Schema

**File:** `src/domain/schemas/OpenAIProvider.schema.ts`

```typescript
import { EntitySchema } from '@mikro-orm/core';
import { OpenAIProvider } from '../entities/OpenAIProvider.js';

export const OpenAIProviderSchema = new EntitySchema<OpenAIProvider>({
  class: OpenAIProvider,
  extends: 'ProviderBase',
  properties: {
    baseUrl: { type: 'text', fieldName: 'base_url', nullable: true },
  },
});
```

### 1.7 Create AzureProvider Schema

**File:** `src/domain/schemas/AzureProvider.schema.ts`

```typescript
import { EntitySchema } from '@mikro-orm/core';
import { AzureProvider } from '../entities/AzureProvider.js';

export const AzureProviderSchema = new EntitySchema<AzureProvider>({
  class: AzureProvider,
  extends: 'ProviderBase',
  properties: {
    baseUrl: { type: 'text', fieldName: 'base_url', nullable: true },
    deployment: { type: 'string', columnType: 'varchar(255)' },
    apiVersion: {
      type: 'string',
      columnType: 'varchar(50)',
      fieldName: 'api_version',
    },
  },
});
```

### 1.8 Create OllamaProvider Schema

**File:** `src/domain/schemas/OllamaProvider.schema.ts`

```typescript
import { EntitySchema } from '@mikro-orm/core';
import { OllamaProvider } from '../entities/OllamaProvider.js';

export const OllamaProviderSchema = new EntitySchema<OllamaProvider>({
  class: OllamaProvider,
  extends: 'ProviderBase',
  properties: {
    baseUrl: { type: 'text', fieldName: 'base_url' },
  },
});
```

### 1.9 Update Schema Index

**File:** `src/domain/schemas/index.ts`

```typescript
// Remove: export { ProviderSchema } from './Provider.schema.js';
// Add:
export { ProviderBaseSchema } from './ProviderBase.schema.js';
export { OpenAIProviderSchema } from './OpenAIProvider.schema.js';
export { AzureProviderSchema } from './AzureProvider.schema.js';
export { OllamaProviderSchema } from './OllamaProvider.schema.js';

// In imports section:
import { ProviderBaseSchema } from './ProviderBase.schema.js';
import { OpenAIProviderSchema } from './OpenAIProvider.schema.js';
import { AzureProviderSchema } from './AzureProvider.schema.js';
import { OllamaProviderSchema } from './OllamaProvider.schema.js';

// In allSchemas array:
export const allSchemas = [
  // ... other schemas
  ProviderBaseSchema,
  OpenAIProviderSchema,
  AzureProviderSchema,
  OllamaProviderSchema,
];
```

### 1.10 Delete Old Files

- Delete `src/domain/entities/Provider.ts`
- Delete `src/domain/schemas/Provider.schema.ts`

### 1.11 Update All Imports

Search and replace throughout codebase:
- `import { Provider }` → `import { ProviderBase }`
- `import type { Provider }` → `import type { ProviderBase }`
- References to `Provider` entity → `ProviderBase`

**Files likely needing updates:**
- `src/providers/registry.ts` (if it references Provider)
- `src/application/services/TenantManagementService.ts` (has evictProvider import)
- Any other service files

### 1.12 No Migration Changes

- Migration 021 already has `type` column (acts as discriminator)
- Migration 022 already seeds with `type = 'openai'`
- No database changes needed!

---

## Part 2: Story 2 - Gateway Provider Management

### 2.1 Create Provider DTOs

**File:** `src/application/dtos/provider.dto.ts`

```typescript
import type { ProviderBase } from '../../domain/entities/ProviderBase.js';

export interface ProviderViewModel {
  id: string;
  name: string;
  description: string | null;
  type: 'openai' | 'azure' | 'ollama';
  isDefault: boolean;
  availableModels: string[];

  // Type-specific fields (nullable for other types)
  baseUrl?: string | null;
  deployment?: string;
  apiVersion?: string;

  // Only for custom providers or admin view
  apiKey?: string;

  createdAt: string;
  updatedAt: string | null;
}

export interface CreateProviderDto {
  name: string;
  description?: string;
  type: 'openai' | 'azure' | 'ollama';
  apiKey: string;
  baseUrl?: string;
  deployment?: string; // Required for Azure
  apiVersion?: string; // Required for Azure
  availableModels?: string[];
}

export interface UpdateProviderDto {
  name?: string;
  description?: string;
  apiKey?: string;
  baseUrl?: string;
  deployment?: string;
  apiVersion?: string;
  availableModels?: string[];
}

export function toProviderViewModel(p: ProviderBase, includeSecrets: boolean = false): ProviderViewModel {
  const base = {
    id: p.id,
    name: p.name,
    description: p.description,
    type: (p.constructor.name === 'OpenAIProvider' ? 'openai' :
           p.constructor.name === 'AzureProvider' ? 'azure' : 'ollama') as 'openai' | 'azure' | 'ollama',
    isDefault: p.isDefault,
    availableModels: p.availableModels,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt ? p.updatedAt.toISOString() : null,
  };

  // Type-specific fields
  const typeFields: any = {};
  if ('baseUrl' in p) typeFields.baseUrl = (p as any).baseUrl;
  if ('deployment' in p) typeFields.deployment = (p as any).deployment;
  if ('apiVersion' in p) typeFields.apiVersion = (p as any).apiVersion;

  if (includeSecrets || !p.isGatewayProvider()) {
    typeFields.apiKey = p.apiKey;
  }

  return { ...base, ...typeFields };
}
```

### 2.2 Create ProviderManagementService

**File:** `src/application/services/ProviderManagementService.ts`

```typescript
import type { EntityManager } from '@mikro-orm/core';
import { ProviderBase } from '../../domain/entities/ProviderBase.js';
import { OpenAIProvider } from '../../domain/entities/OpenAIProvider.js';
import { AzureProvider } from '../../domain/entities/AzureProvider.js';
import { OllamaProvider } from '../../domain/entities/OllamaProvider.js';
import type { CreateProviderDto, UpdateProviderDto, ProviderViewModel } from '../dtos/provider.dto.js';
import { toProviderViewModel } from '../dtos/provider.dto.js';

export class ProviderManagementService {
  constructor(private readonly em: EntityManager) {}

  /**
   * List all gateway providers (admin view with secrets)
   */
  async listGatewayProviders(): Promise<ProviderViewModel[]> {
    const providers = await this.em.find(ProviderBase, { tenant: null });
    return providers.map(p => toProviderViewModel(p, true));
  }

  /**
   * Create a gateway provider
   */
  async createGatewayProvider(dto: CreateProviderDto): Promise<ProviderViewModel> {
    let provider: ProviderBase;

    switch (dto.type) {
      case 'openai':
        provider = new OpenAIProvider(dto.name, dto.apiKey, {
          description: dto.description,
          availableModels: dto.availableModels,
        });
        (provider as OpenAIProvider).baseUrl = dto.baseUrl ?? null;
        break;

      case 'azure':
        if (!dto.deployment) throw new Error('deployment is required for Azure');
        if (!dto.apiVersion) throw new Error('apiVersion is required for Azure');

        provider = new AzureProvider(dto.name, dto.apiKey, {
          description: dto.description,
          availableModels: dto.availableModels,
        });
        (provider as AzureProvider).baseUrl = dto.baseUrl ?? null;
        (provider as AzureProvider).deployment = dto.deployment;
        (provider as AzureProvider).apiVersion = dto.apiVersion;
        break;

      case 'ollama':
        if (!dto.baseUrl) throw new Error('baseUrl is required for Ollama');

        provider = new OllamaProvider(dto.name, dto.apiKey, {
          description: dto.description,
          availableModels: dto.availableModels,
        });
        (provider as OllamaProvider).baseUrl = dto.baseUrl;
        break;

      default:
        throw new Error(`Unknown provider type: ${dto.type}`);
    }

    provider.validate();
    this.em.persist(provider);
    await this.em.flush();

    return toProviderViewModel(provider, true);
  }

  /**
   * Update a gateway provider
   */
  async updateGatewayProvider(id: string, dto: UpdateProviderDto): Promise<ProviderViewModel> {
    const provider = await this.em.findOneOrFail(ProviderBase, { id, tenant: null });

    if (dto.name !== undefined) provider.name = dto.name;
    if (dto.description !== undefined) provider.description = dto.description;
    if (dto.apiKey !== undefined) provider.apiKey = dto.apiKey;
    if (dto.availableModels !== undefined) provider.availableModels = dto.availableModels;

    // Type-specific updates
    if ('baseUrl' in provider && dto.baseUrl !== undefined) {
      (provider as any).baseUrl = dto.baseUrl;
    }
    if ('deployment' in provider && dto.deployment !== undefined) {
      (provider as any).deployment = dto.deployment;
    }
    if ('apiVersion' in provider && dto.apiVersion !== undefined) {
      (provider as any).apiVersion = dto.apiVersion;
    }

    provider.updatedAt = new Date();
    provider.validate();
    await this.em.flush();

    return toProviderViewModel(provider, true);
  }

  /**
   * Delete a gateway provider (checks if in use)
   */
  async deleteGatewayProvider(id: string): Promise<void> {
    const provider = await this.em.findOneOrFail(ProviderBase, { id, tenant: null });

    // TODO: Check if provider is in use by any agents
    // const agentCount = await this.em.count(Agent, { provider: id });
    // if (agentCount > 0) {
    //   throw Object.assign(new Error('Provider is in use'), { status: 400 });
    // }

    await this.em.removeAndFlush(provider);
  }

  /**
   * Set a gateway provider as default (unsets others)
   */
  async setGatewayDefault(id: string): Promise<ProviderViewModel> {
    const provider = await this.em.findOneOrFail(ProviderBase, { id, tenant: null });

    // Unset all other defaults
    const currentDefaults = await this.em.find(ProviderBase, { tenant: null, isDefault: true });
    for (const p of currentDefaults) {
      if (p.id !== id) {
        p.isDefault = false;
      }
    }

    provider.isDefault = true;
    await this.em.flush();

    return toProviderViewModel(provider, true);
  }
}
```

### 2.3 Create Admin Provider Routes

**File:** `src/infrastructure/api/routes/admin/providers.ts`

```typescript
import type { FastifyInstance } from 'fastify';
import { ProviderManagementService } from '../../../../application/services/ProviderManagementService.js';
import type { CreateProviderDto, UpdateProviderDto } from '../../../../application/dtos/provider.dto.js';

export default async function providerRoutes(fastify: FastifyInstance) {
  const service = new ProviderManagementService(fastify.orm.em.fork());

  // List gateway providers
  fastify.get('/providers', async (request, reply) => {
    const providers = await service.listGatewayProviders();
    return providers;
  });

  // Create gateway provider
  fastify.post<{ Body: CreateProviderDto }>('/providers', async (request, reply) => {
    const provider = await service.createGatewayProvider(request.body);
    return reply.status(201).send(provider);
  });

  // Update gateway provider
  fastify.put<{ Params: { id: string }; Body: UpdateProviderDto }>(
    '/providers/:id',
    async (request, reply) => {
      const provider = await service.updateGatewayProvider(request.params.id, request.body);
      return provider;
    }
  );

  // Delete gateway provider
  fastify.delete<{ Params: { id: string } }>('/providers/:id', async (request, reply) => {
    await service.deleteGatewayProvider(request.params.id);
    return reply.status(204).send();
  });

  // Set gateway default
  fastify.post<{ Params: { id: string } }>('/providers/:id/default', async (request, reply) => {
    const provider = await service.setGatewayDefault(request.params.id);
    return provider;
  });
}
```

### 2.4 Register Admin Routes

**File:** `src/infrastructure/api/routes/admin/index.ts` (or wherever admin routes are registered)

Add:
```typescript
import providerRoutes from './providers.js';

// In the admin routes setup:
fastify.register(providerRoutes, { prefix: '/admin' });
```

### 2.5 Frontend: Create ProvidersPage

**File:** `admin/src/pages/ProvidersPage.tsx`

```tsx
import React, { useState, useEffect } from 'react';
import { Button, Table, Badge, Modal } from '../components'; // Adjust to your UI library
import { ProviderForm } from '../components/ProviderForm';
import type { ProviderViewModel } from '../types/provider';

export function ProvidersPage() {
  const [providers, setProviders] = useState<ProviderViewModel[]>([]);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<ProviderViewModel | null>(null);

  useEffect(() => {
    loadProviders();
  }, []);

  const loadProviders = async () => {
    const res = await fetch('/v1/admin/providers', {
      headers: { Authorization: `Bearer ${getAdminToken()}` }
    });
    const data = await res.json();
    setProviders(data);
  };

  const handleSetDefault = async (id: string) => {
    await fetch(`/v1/admin/providers/${id}/default`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${getAdminToken()}` }
    });
    loadProviders();
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this provider?')) return;
    await fetch(`/v1/admin/providers/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${getAdminToken()}` }
    });
    loadProviders();
  };

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <h1>Gateway Providers</h1>
        <Button onClick={() => setIsCreateModalOpen(true)}>Create Provider</Button>
      </div>

      <Table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>Description</th>
            <th>Available Models</th>
            <th>Default</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {providers.map(p => (
            <tr key={p.id}>
              <td>{p.name}</td>
              <td><Badge>{p.type}</Badge></td>
              <td>{p.description}</td>
              <td>{p.availableModels.join(', ') || 'All'}</td>
              <td>{p.isDefault && <Badge>Default</Badge>}</td>
              <td>
                <Button size="sm" onClick={() => setEditingProvider(p)}>Edit</Button>
                {!p.isDefault && (
                  <Button size="sm" onClick={() => handleSetDefault(p.id)}>Set Default</Button>
                )}
                <Button size="sm" variant="danger" onClick={() => handleDelete(p.id)}>Delete</Button>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>

      <Modal isOpen={isCreateModalOpen} onClose={() => setIsCreateModalOpen(false)}>
        <ProviderForm
          onSuccess={() => {
            setIsCreateModalOpen(false);
            loadProviders();
          }}
          onCancel={() => setIsCreateModalOpen(false)}
        />
      </Modal>

      <Modal isOpen={!!editingProvider} onClose={() => setEditingProvider(null)}>
        {editingProvider && (
          <ProviderForm
            provider={editingProvider}
            onSuccess={() => {
              setEditingProvider(null);
              loadProviders();
            }}
            onCancel={() => setEditingProvider(null)}
          />
        )}
      </Modal>
    </div>
  );
}

function getAdminToken(): string {
  // TODO: Implement token retrieval
  return '';
}
```

### 2.6 Frontend: Create ProviderForm

**File:** `admin/src/components/ProviderForm.tsx`

```tsx
import React, { useState } from 'react';
import { Button, Input, Select, Textarea } from './ui'; // Adjust to your UI library
import type { ProviderViewModel } from '../types/provider';

interface ProviderFormProps {
  provider?: ProviderViewModel;
  onSuccess: () => void;
  onCancel: () => void;
}

export function ProviderForm({ provider, onSuccess, onCancel }: ProviderFormProps) {
  const [type, setType] = useState<'openai' | 'azure' | 'ollama'>(provider?.type || 'openai');
  const [name, setName] = useState(provider?.name || '');
  const [description, setDescription] = useState(provider?.description || '');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl || '');
  const [deployment, setDeployment] = useState(provider?.deployment || '');
  const [apiVersion, setApiVersion] = useState(provider?.apiVersion || '');
  const [availableModels, setAvailableModels] = useState<string>(
    provider?.availableModels.join(', ') || ''
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const body = {
      name,
      description,
      type,
      apiKey: apiKey || undefined,
      baseUrl: baseUrl || undefined,
      deployment: deployment || undefined,
      apiVersion: apiVersion || undefined,
      availableModels: availableModels.split(',').map(s => s.trim()).filter(Boolean),
    };

    const url = provider
      ? `/v1/admin/providers/${provider.id}`
      : '/v1/admin/providers';
    const method = provider ? 'PUT' : 'POST';

    await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getAdminToken()}`
      },
      body: JSON.stringify(body)
    });

    onSuccess();
  };

  return (
    <form onSubmit={handleSubmit}>
      <h2>{provider ? 'Edit Provider' : 'Create Provider'}</h2>

      <Select
        label="Type"
        value={type}
        onChange={(e) => setType(e.target.value as any)}
        disabled={!!provider}
      >
        <option value="openai">OpenAI</option>
        <option value="azure">Azure</option>
        <option value="ollama">Ollama</option>
      </Select>

      <Input
        label="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
      />

      <Textarea
        label="Description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />

      <Input
        label="API Key"
        type="password"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        required={!provider}
        placeholder={provider ? 'Leave blank to keep current' : ''}
      />

      {(type === 'openai' || type === 'azure') && (
        <Input
          label="Base URL"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder={type === 'openai' ? 'Optional' : 'https://your-resource.openai.azure.com'}
        />
      )}

      {type === 'azure' && (
        <>
          <Input
            label="Deployment"
            value={deployment}
            onChange={(e) => setDeployment(e.target.value)}
            required
          />
          <Input
            label="API Version"
            value={apiVersion}
            onChange={(e) => setApiVersion(e.target.value)}
            required
            placeholder="2024-02-15"
          />
        </>
      )}

      {type === 'ollama' && (
        <Input
          label="Base URL"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          required
          placeholder="http://localhost:11434"
        />
      )}

      <Input
        label="Available Models"
        value={availableModels}
        onChange={(e) => setAvailableModels(e.target.value)}
        placeholder="gpt-4o, gpt-4o-mini (comma-separated, leave blank for all)"
      />

      <div className="flex gap-2 mt-4">
        <Button type="submit">Save</Button>
        <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

function getAdminToken(): string {
  // TODO: Implement token retrieval
  return '';
}
```

### 2.7 Add Navigation

**File:** `admin/src/App.tsx` (or wherever navigation is defined)

Add to sidebar:
```tsx
<NavLink to="/providers">Providers</NavLink>
```

Add route:
```tsx
<Route path="/providers" element={<ProvidersPage />} />
```

---

## Testing

### 2.8 Unit Tests

**File:** `tests/unit/ProviderManagementService.test.ts`

- Test listGatewayProviders()
- Test createGatewayProvider() for each type
- Test validation errors (missing Azure deployment, etc.)
- Test updateGatewayProvider()
- Test deleteGatewayProvider()
- Test setGatewayDefault() (unsets others)

### 2.9 Smoke Tests

**File:** `tests/smoke/admin-providers.test.ts`

- Admin can create OpenAI provider
- Admin can create Azure provider with required fields
- Admin can list providers
- Admin can set default provider
- Admin can update provider
- Admin can delete provider

---

## Documentation

### 2.10 Update CHANGELOG.md

Add to unreleased section:
```markdown
### Changed
- **Provider Entity Refactor**: Converted Provider to use Single Table Inheritance (STI)
  - ProviderBase abstract class with OpenAIProvider, AzureProvider, OllamaProvider subclasses
  - Polymorphic methods: validate(), createClient(), sanitizeForTenant()
  - Type-safe provider-specific logic with ORM-level discrimination

### Added
- **Gateway Provider Management**: Admin dashboard for managing gateway providers
  - Admin API endpoints: GET/POST/PUT/DELETE /v1/admin/providers
  - ProvidersPage UI with CRUD operations
  - Set default provider functionality
  - Dynamic form fields based on provider type
```

### 2.11 Commit and Push

```bash
git add .
git commit -m "feat: Refactor Provider to STI and add gateway management (#103)

## Provider Entity Refactor (STI)
- Converted Provider to ProviderBase abstract class
- Created OpenAIProvider, AzureProvider, OllamaProvider subclasses
- MikroORM discriminator on 'type' column
- Polymorphic validate() and createClient() methods
- Type-safe provider-specific fields and logic

## Gateway Provider Management (Story 2)
- ProviderManagementService with CRUD operations
- Admin API routes: /v1/admin/providers (GET/POST/PUT/DELETE)
- Set default provider endpoint
- Admin ProvidersPage with table and forms
- ProviderForm with dynamic fields per type

Closes #103"

git push origin main
```

---

## Summary

**Part 1: STI Refactor**
- ProviderBase + 3 concrete classes (OpenAI, Azure, Ollama)
- Type-specific fields and validation
- No migration changes (type column already exists)
- Clean polymorphism at ORM level

**Part 2: Story 2**
- Backend: ProviderManagementService + admin routes
- Frontend: ProvidersPage + ProviderForm
- Dynamic form fields based on provider type
- Full CRUD + set default functionality

**Ready for:** Story 3 (Tenant Custom Provider Management)

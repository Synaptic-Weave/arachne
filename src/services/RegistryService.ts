import type { EntityManager } from '@mikro-orm/core';
import { Artifact } from '../domain/entities/Artifact.js';
import { ArtifactTag } from '../domain/entities/ArtifactTag.js';
import { KbChunk } from '../domain/entities/KbChunk.js';
import { VectorSpace } from '../domain/entities/VectorSpace.js';
import { Tenant } from '../domain/entities/Tenant.js';

export interface PushInput {
  tenantId: string;
  org: string;
  name: string;
  tag: string;
  kind: string;
  bundleData: Buffer;
  sha256: string;
  chunkCount?: number;
  chunks?: Array<{
    content: string;
    sourcePath: string;
    tokenCount: number;
    embedding: number[];
    metadata?: Record<string, unknown>;
  }>;
  vectorSpaceData?: {
    provider: string;
    model: string;
    dimensions: number;
    preprocessingHash: string;
  };
}

export interface ArtifactRef {
  org: string;
  name: string;
  tag: string;
}

export class RegistryService {
  /**
   * Push (publish) an artifact. Idempotent: returns existing artifact if sha256 already stored.
   */
  async push(
    input: PushInput,
    em: EntityManager,
  ): Promise<{ artifactId: string; ref: string }> {
    // 1. Idempotency: exact same content (SHA match) — just ensure tag exists
    const existing = await em.findOne(Artifact, {
      sha256: input.sha256,
      tenant: input.tenantId,
    });

    if (existing) {
      // Ensure tag points to the existing artifact
      await this._upsertTag(existing, input.tag, em);
      await em.flush();
      return {
        artifactId: existing.id,
        ref: `${input.org}/${input.name}:${input.tag}`,
      };
    }

    // 2. Check for existing artifact with same org/name for this tenant
    const sameNameArtifact = await em.findOne(Artifact, {
      tenant: input.tenantId,
      org: input.org,
      name: input.name,
    });

    if (sameNameArtifact) {
      // Update existing artifact with new content
      sameNameArtifact.sha256 = input.sha256;
      sameNameArtifact.bundleData = input.bundleData;
      sameNameArtifact.chunkCount = input.chunkCount ?? 0;

      // Update VectorSpace if embedding config changed
      if (input.kind === 'KnowledgeBase' && input.vectorSpaceData) {
        if (sameNameArtifact.vectorSpace) {
          // Update existing VectorSpace in place
          const vs = sameNameArtifact.vectorSpace;
          vs.provider = input.vectorSpaceData.provider;
          vs.model = input.vectorSpaceData.model;
          vs.dimensions = input.vectorSpaceData.dimensions;
          vs.preprocessingHash = input.vectorSpaceData.preprocessingHash;
        } else {
          const vectorSpace = new VectorSpace(
            input.vectorSpaceData.provider,
            input.vectorSpaceData.model,
            input.vectorSpaceData.dimensions,
            input.vectorSpaceData.preprocessingHash,
          );
          em.persist(vectorSpace);
          sameNameArtifact.vectorSpace = vectorSpace;
        }
      }

      // Delete old chunks and insert new ones
      const oldChunks = await em.find(KbChunk, { artifact: sameNameArtifact.id });
      for (const chunk of oldChunks) {
        em.remove(chunk);
      }

      if (input.kind === 'KnowledgeBase' && input.chunks && input.chunks.length > 0) {
        for (const [idx, c] of input.chunks.entries()) {
          const chunk = new KbChunk(sameNameArtifact, idx, c.content, {
            sourcePath: c.sourcePath,
            tokenCount: c.tokenCount,
            embedding: c.embedding,
            metadata: c.metadata,
          });
          em.persist(chunk);
        }
      }

      await this._upsertTag(sameNameArtifact, input.tag, em);
      await em.flush();
      return {
        artifactId: sameNameArtifact.id,
        ref: `${input.org}/${input.name}:${input.tag}`,
      };
    }

    // 3. Brand new artifact — create
    const tenant = await em.findOneOrFail(Tenant, { id: input.tenantId });

    // Build optional VectorSpace for KnowledgeBase artifacts
    let vectorSpace: VectorSpace | undefined;
    if (input.kind === 'KnowledgeBase' && input.vectorSpaceData) {
      vectorSpace = new VectorSpace(
        input.vectorSpaceData.provider,
        input.vectorSpaceData.model,
        input.vectorSpaceData.dimensions,
        input.vectorSpaceData.preprocessingHash,
      );
      em.persist(vectorSpace);
    }

    const artifact = new Artifact(
      tenant,
      input.org,
      input.name,
      input.tag,
      input.kind as Artifact['kind'],
      input.sha256,
      input.bundleData,
      {
        vectorSpace,
        chunkCount: input.chunkCount,
      },
    );
    em.persist(artifact);

    // Bulk-create KB chunks
    if (input.kind === 'KnowledgeBase' && input.chunks && input.chunks.length > 0) {
      const chunks = input.chunks.map(
        (c, idx) =>
          new KbChunk(artifact, idx, c.content, {
            sourcePath: c.sourcePath,
            tokenCount: c.tokenCount,
            embedding: c.embedding,
            metadata: c.metadata,
          }),
      );
      for (const chunk of chunks) {
        em.persist(chunk);
      }
    }

    await this._upsertTag(artifact, input.tag, em);
    await em.flush();

    return {
      artifactId: artifact.id,
      ref: `${input.org}/${input.name}:${input.tag}`,
    };
  }

  /**
   * Resolve an artifact by org/name:tag. Returns null if not found or tenant mismatch.
   */
  async resolve(
    ref: ArtifactRef,
    tenantId: string,
    em: EntityManager,
  ): Promise<Artifact | null> {
    const artifactTag = await em.findOne(
      ArtifactTag,
      { tag: ref.tag, artifact: { org: ref.org, name: ref.name, tenant: tenantId } },
      { populate: ['artifact'] },
    );

    if (!artifactTag) return null;

    const artifact = artifactTag.artifact as Artifact;
    // Tenant-scope guard
    if ((artifact.tenant as any)?.id !== tenantId && (artifact.tenant as unknown as string) !== tenantId) {
      return null;
    }

    return artifact;
  }

  /**
   * List all artifacts for a tenant/org, grouped by name.
   */
  async list(
    tenantId: string,
    org: string,
    em: EntityManager,
  ): Promise<Array<{ name: string; tags: string[]; kind: string; latestVersion: string }>> {
    const artifacts = await em.find(
      Artifact,
      { tenant: tenantId, org },
      { populate: ['tags'], orderBy: { createdAt: 'DESC' } },
    );

    // Group by name
    const byName = new Map<
      string,
      { kind: string; tags: string[]; latestVersion: string }
    >();

    for (const artifact of artifacts) {
      if (!byName.has(artifact.name)) {
        byName.set(artifact.name, {
          kind: artifact.kind,
          tags: [],
          latestVersion: artifact.version,
        });
      }
      const entry = byName.get(artifact.name)!;
      for (const at of artifact.tags) {
        const tagName = (at as ArtifactTag).tag;
        if (!entry.tags.includes(tagName)) {
          entry.tags.push(tagName);
        }
      }
    }

    return Array.from(byName.entries()).map(([name, data]) => ({
      name,
      tags: data.tags,
      kind: data.kind,
      latestVersion: data.latestVersion,
    }));
  }

  /**
   * Pull bundle data for an artifact. Returns null if not found.
   */
  async pull(
    ref: ArtifactRef,
    tenantId: string,
    em: EntityManager,
  ): Promise<Buffer | null> {
    const artifact = await this.resolve(ref, tenantId, em);
    return artifact ? artifact.bundleData : null;
  }

  /**
   * Delete an artifact tag. Removes artifact + chunks if no other tags point to it.
   * Returns true if anything was deleted.
   */
  async delete(
    ref: ArtifactRef,
    tenantId: string,
    em: EntityManager,
  ): Promise<boolean> {
    const artifactTag = await em.findOne(
      ArtifactTag,
      { tag: ref.tag, artifact: { org: ref.org, name: ref.name, tenant: tenantId } },
      { populate: ['artifact'] },
    );

    if (!artifactTag) return false;

    const artifact = artifactTag.artifact as Artifact;
    em.remove(artifactTag);

    // Check how many other tags point to the same artifact version
    const remainingTagCount = await em.count(ArtifactTag, {
      artifact: artifact.id,
      id: { $ne: artifactTag.id },
    });

    if (remainingTagCount === 0) {
      // Remove associated chunks
      const chunks = await em.find(KbChunk, { artifact: artifact.id });
      for (const chunk of chunks) {
        em.remove(chunk);
      }
      em.remove(artifact);
    }

    await em.flush();
    return true;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async _upsertTag(
    artifact: Artifact,
    tag: string,
    em: EntityManager,
  ): Promise<ArtifactTag> {
    const existing = await em.findOne(ArtifactTag, {
      tag,
      artifact: { org: artifact.org, name: artifact.name, tenant: artifact.tenant },
    });

    if (existing) {
      (existing as ArtifactTag).reassign(artifact);
      return existing;
    }

    const artifactTag = new ArtifactTag(artifact, tag);
    em.persist(artifactTag);
    return artifactTag;
  }
}

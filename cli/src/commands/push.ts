import { Command } from 'commander';
import { readFileSync, existsSync } from 'fs';
import { resolve, basename } from 'path';
import { gunzipSync } from 'zlib';
import { getGatewayUrl, getToken } from '../config.js';
import { extractFileFromTar } from '../lib/tar.js';

interface OrbManifest {
  name: string;
  kind: string;
  sha256?: string;
  chunkCount?: number;
}

/**
 * Extract manifest.json from a gzipped tar (.orb) buffer.
 */
export function extractManifest(bundleBuf: Buffer): OrbManifest {
  const tarBuf = gunzipSync(bundleBuf);
  const manifestData = extractFileFromTar(tarBuf, 'manifest.json');

  if (!manifestData) {
    throw new Error('No manifest.json found in .orb bundle');
  }

  const manifest = JSON.parse(manifestData.toString('utf8'));

  if (!manifest.name || !manifest.kind) {
    throw new Error('manifest.json missing required "name" or "kind" fields');
  }

  return {
    name: manifest.name,
    kind: manifest.kind,
    sha256: manifest.sha256,
    chunkCount: manifest.chunkCount,
  };
}

export const pushCommand = new Command('push')
  .description('Push an artifact bundle to the registry')
  .argument('<bundle>', 'Path to the .orb artifact file')
  .option('--tag <tag>', 'Tag for this artifact version', 'latest')
  .action(async (bundlePath: string, options: { tag: string }) => {
    let gatewayUrl: string;
    let token: string;
    try {
      gatewayUrl = getGatewayUrl();
      token = getToken();
    } catch {
      console.error("Error: not logged in. Run 'arachne login' first.");
      process.exit(1);
    }

    const absPath = resolve(bundlePath);
    if (!existsSync(absPath)) {
      console.error(`Error: bundle file not found: ${bundlePath}`);
      process.exit(1);
    }

    const bundleBuf = readFileSync(absPath);

    // Extract manifest to send name/kind metadata
    let manifest: OrbManifest;
    try {
      manifest = extractManifest(bundleBuf);
    } catch (err) {
      console.error(`Error reading .orb bundle: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }

    const form = new FormData();
    form.append('bundle', new Blob([bundleBuf], { type: 'application/gzip' }), basename(absPath));
    form.append('tag', options.tag);
    form.append('name', manifest.name);
    form.append('kind', manifest.kind);
    if (manifest.sha256) form.append('sha256', manifest.sha256);
    if (manifest.chunkCount) form.append('chunkCount', String(manifest.chunkCount));

    const res = await fetch(`${gatewayUrl}/v1/registry/push`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: form,
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`Error: ${res.status} ${body}`);
      process.exit(1);
    }

    const data = await res.json() as { ref: string };
    console.log(`Pushed -> ${data.ref}`);
  });

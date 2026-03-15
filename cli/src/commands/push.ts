import { Command } from 'commander';
import { readFileSync, existsSync } from 'fs';
import { resolve, basename } from 'path';
import { getGatewayUrl, getToken } from '../config.js';

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
    const form = new FormData();
    form.append('bundle', new Blob([bundleBuf], { type: 'application/gzip' }), basename(absPath));
    form.append('tag', options.tag);

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
    console.log(`✓ Pushed → ${data.ref}`);
  });

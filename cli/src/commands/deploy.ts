import { Command } from 'commander';
import { getGatewayUrl, getToken } from '../config.js';
import { handleApiError } from '../lib/errors.js';

function parseArtifactRef(ref: string): { org: string; name: string; tag: string } {
  const match = ref.match(/^([^/]+)\/([^:]+)(?::(.+))?$/);
  if (!match) {
    throw new Error(`Invalid artifact reference: "${ref}". Expected format: org/name[:tag]`);
  }
  return {
    org: match[1],
    name: match[2],
    tag: match[3] || 'latest'
  };
}

export const deployCommand = new Command('deploy')
  .description('Deploy an artifact to a runtime environment')
  .argument('<artifact>', 'Artifact reference (org/name[:tag], tag defaults to "latest")')
  .option('--environment <env>', 'Deployment environment (defaults to "production")', 'production')
  .option('--name <name>', 'Custom deployment name (defaults to artifactName-environment)')
  .action(async (artifact: string, options: { environment: string; name?: string }) => {
    let gatewayUrl: string;
    let token: string;
    try {
      gatewayUrl = getGatewayUrl();
      token = getToken();
    } catch {
      console.error("Error: not logged in. Run 'arachne login' first.");
      process.exit(1);
    }

    let parsed: { org: string; name: string; tag: string };
    try {
      parsed = parseArtifactRef(artifact);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }

    const { org, name, tag } = parsed;
    const environment = options.environment;

    // Build URL with path params and query string
    const url = new URL(`${gatewayUrl}/v1/registry/deployments/${org}/${name}/${tag}`);
    url.searchParams.set('environment', environment);
    if (options.name) {
      url.searchParams.set('name', options.name);
    }

    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });

    if (!res.ok) {
      handleApiError(res.status, await res.text());
    }

    const data = await res.json() as { deploymentId: string; name?: string; status: string; runtimeToken?: string };
    console.log(`✓ Deployed ${org}/${name}:${tag} → ${environment}`);
    console.log(`  Deployment ID: ${data.deploymentId}`);
    if (data.name) {
      console.log(`  Name: ${data.name}`);
    }
    console.log(`  Status: ${data.status}`);
    if (data.runtimeToken) {
      console.log(`  Runtime token: ${data.runtimeToken.substring(0, 20)}...`);
    }
  });

import { Command } from 'commander';
import { getGatewayUrl, getToken } from '../config.js';
import { handleApiError } from '../lib/errors.js';

interface DeploymentEntry {
  id: string;
  name: string;
  environment: string;
  status: string;
  deployedAt: string | null;
  artifact?: { name?: string };
}

export const listCommand = new Command('list')
  .description('List all deployments for the current tenant')
  .action(async () => {
    let gatewayUrl: string;
    let token: string;
    try {
      gatewayUrl = getGatewayUrl();
      token = getToken();
    } catch {
      console.error("Error: not logged in. Run 'arachne login' first.");
      process.exit(1);
    }

    const res = await fetch(`${gatewayUrl}/v1/registry/deployments`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });

    if (!res.ok) {
      handleApiError(res.status, await res.text());
    }

    const deployments = await res.json() as DeploymentEntry[];

    if (deployments.length === 0) {
      console.log('No deployments found.');
      return;
    }

    // Calculate column widths
    const headers = { name: 'NAME', artifact: 'ARTIFACT', env: 'ENV', status: 'STATUS', deployed: 'DEPLOYED' };
    const rows = deployments.map((d) => ({
      name: d.name ?? '-',
      artifact: d.artifact?.name ?? '-',
      env: d.environment ?? '-',
      status: d.status ?? '-',
      deployed: d.deployedAt ? new Date(d.deployedAt).toISOString().replace('T', ' ').slice(0, 19) : '-',
    }));

    const colWidths = {
      name: Math.max(headers.name.length, ...rows.map((r) => r.name.length)),
      artifact: Math.max(headers.artifact.length, ...rows.map((r) => r.artifact.length)),
      env: Math.max(headers.env.length, ...rows.map((r) => r.env.length)),
      status: Math.max(headers.status.length, ...rows.map((r) => r.status.length)),
      deployed: Math.max(headers.deployed.length, ...rows.map((r) => r.deployed.length)),
    };

    const formatRow = (r: { name: string; artifact: string; env: string; status: string; deployed: string }) =>
      `${r.name.padEnd(colWidths.name)}  ${r.artifact.padEnd(colWidths.artifact)}  ${r.env.padEnd(colWidths.env)}  ${r.status.padEnd(colWidths.status)}  ${r.deployed}`;

    console.log(formatRow(headers));
    for (const row of rows) {
      console.log(formatRow(row));
    }
  });

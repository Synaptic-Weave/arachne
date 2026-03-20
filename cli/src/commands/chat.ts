import { Command } from 'commander';
import { createInterface } from 'node:readline';
import { getGatewayUrl, getToken } from '../config.js';

function handleApiError(res: Response, body: string): void {
  if (res.status === 401) {
    console.error('Error: authentication failed. Your token may have expired. Run: arachne login');
  } else if (res.status === 403) {
    console.error('Error: insufficient permissions.');
  } else {
    console.error(`Error: ${res.status} ${body}`);
  }
}

async function resolveDeployment(
  gatewayUrl: string,
  token: string,
  name: string,
): Promise<{ runtimeToken: string; deploymentId: string } | null> {
  // List all deployments and filter by artifact name client-side
  // (the by-name endpoint may not exist yet)
  const res = await fetch(`${gatewayUrl}/v1/registry/deployments`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const body = await res.text();
    handleApiError(res, body);
    return null;
  }

  const deployments = (await res.json()) as Array<{
    id: string;
    status: string;
    runtimeToken: string | null;
    artifact?: { name?: string };
  }>;

  const match = deployments.find(
    (d) => d.artifact?.name === name && d.status === 'READY',
  );

  if (!match) {
    const any = deployments.find((d) => d.artifact?.name === name);
    if (any) {
      console.error(`Error: deployment "${name}" exists but status is ${any.status} (expected READY).`);
    } else {
      console.error(`Error: no deployment found with name "${name}". Run: arachne deploy <org>/${name}`);
    }
    return null;
  }

  if (!match.runtimeToken) {
    console.error(`Error: deployment "${name}" has no runtime token.`);
    return null;
  }

  return { runtimeToken: match.runtimeToken, deploymentId: match.id };
}

async function sendChat(
  gatewayUrl: string,
  runtimeToken: string,
  messages: Array<{ role: string; content: string }>,
  model: string,
): Promise<string | null> {
  const res = await fetch(`${gatewayUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${runtimeToken}`,
    },
    body: JSON.stringify({ model, messages }),
  });

  if (!res.ok) {
    const body = await res.text();
    handleApiError(res, body);
    return null;
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  return data.choices?.[0]?.message?.content ?? null;
}

export const chatCommand = new Command('chat')
  .description('Chat with a deployed agent')
  .argument('<name>', 'Deployment name (artifact name)')
  .option('-m, --message <message>', 'Send a single message (one-shot mode)')
  .option('--model <model>', 'Model to use', 'gpt-4.1')
  .action(async (name: string, options: { message?: string; model: string }) => {
    let gatewayUrl: string;
    let token: string;
    try {
      gatewayUrl = getGatewayUrl();
      token = getToken();
    } catch {
      console.error("Error: not logged in. Run 'arachne login' first.");
      process.exit(1);
    }

    const deployment = await resolveDeployment(gatewayUrl, token, name);
    if (!deployment) {
      process.exit(1);
    }

    const { runtimeToken } = deployment;
    const model = options.model;

    // ── One-shot mode ──────────────────────────────────────────────────────
    if (options.message) {
      const content = await sendChat(
        gatewayUrl,
        runtimeToken,
        [{ role: 'user', content: options.message }],
        model,
      );
      if (content === null) {
        process.exit(1);
      }
      console.log(content);
      return;
    }

    // ── Interactive mode ───────────────────────────────────────────────────
    console.log(`Chat with ${name} (type /quit to exit)`);

    const messages: Array<{ role: string; content: string }> = [];

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const prompt = (): void => {
      rl.question('> ', async (input) => {
        const trimmed = input.trim();
        if (trimmed === '/quit' || trimmed === '/exit') {
          rl.close();
          return;
        }

        if (!trimmed) {
          prompt();
          return;
        }

        messages.push({ role: 'user', content: trimmed });

        const content = await sendChat(gatewayUrl, runtimeToken, messages, model);
        if (content === null) {
          // Remove the failed message so the user can retry
          messages.pop();
          prompt();
          return;
        }

        messages.push({ role: 'assistant', content });
        console.log(content);
        prompt();
      });
    };

    rl.on('close', () => {
      process.exit(0);
    });

    prompt();
  });

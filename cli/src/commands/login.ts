import { Command } from 'commander';
import * as readline from 'readline';
import { writeConfig } from '../config.js';

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function promptPassword(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const chars: string[] = [];

    const stdin = process.stdin as NodeJS.ReadStream;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          cleanup();
          process.stdout.write('\n');
          resolve(chars.join(''));
          return;
        } else if (char === '\u0003') { // Ctrl+C
          cleanup();
          process.exit(1);
        } else if (char === '\u007f') { // backspace
          chars.pop();
        } else {
          chars.push(char);
        }
      }
    };

    const cleanup = () => {
      stdin.removeListener('data', onData);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
    };

    stdin.on('data', onData);
  });
}

const DEFAULT_GATEWAY = 'https://api.arachne-ai.com';

export const loginCommand = new Command('login')
  .description('Authenticate with an Arachne gateway')
  .argument('[url]', 'Gateway URL (defaults to ARACHNE_GATEWAY_URL env var)')
  .action(async (url?: string) => {
    const gatewayUrl = url
      ?? process.env.ARACHNE_GATEWAY_URL
      ?? (await prompt(`Gateway URL (${DEFAULT_GATEWAY}): `)).trim()
      || DEFAULT_GATEWAY;

    const email = await prompt('Email: ');
    const password = await promptPassword('Password: ');

    let res: Response;
    try {
      res = await fetch(`${gatewayUrl}/v1/portal/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
    } catch (err) {
      console.error(`Error: could not reach gateway: ${(err as Error).message}`);
      process.exit(1);
    }

    if (!res.ok) {
      const body = await res.text();
      console.error(`Error: ${res.status} ${body}`);
      process.exit(1);
    }

    const data = await res.json() as { token: string; expiresAt?: string };
    writeConfig({ gatewayUrl, token: data.token });
    console.log(`✓ Logged in to ${gatewayUrl}`);
  });

import { Command } from 'commander';
import { writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import * as readline from 'readline';

type ArtifactKind = 'agent' | 'kb' | 'embedding-agent';

const DEFAULT_NAMES: Record<ArtifactKind, string> = {
  'agent': 'my-agent',
  'kb': 'my-kb',
  'embedding-agent': 'my-embedder',
};

const TEMPLATES: Record<ArtifactKind, (name: string) => string> = {
  agent: (name) => `apiVersion: arachne-ai.com/v0
kind: Agent
metadata:
  name: ${name}
spec:
  model: gpt-4.1-mini
  systemPrompt: |
    You are a helpful assistant.
  # knowledgeBaseRef: my-kb
  # conversationsEnabled: true
  # conversationTokenLimit: 4000
`,

  kb: (name) => `apiVersion: arachne-ai.com/v0
kind: KnowledgeBase
metadata:
  name: ${name}
  docsPath: ./docs
spec:
  chunking:
    tokenSize: 650
    overlap: 120
  retrieval:
    topK: 8
    citations: true
`,

  'embedding-agent': (name) => `apiVersion: arachne-ai.com/v0
kind: EmbeddingAgent
metadata:
  name: ${name}
spec:
  provider: openai
  model: text-embedding-3-small
`,
};

function promptInteractive(question: string, choices: string[]): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const display = `${question} (${choices.join('/')}): `;
  return new Promise((res) => {
    rl.question(display, (answer) => {
      rl.close();
      res(answer.trim().toLowerCase());
    });
  });
}

export function createInitCommand(): Command {
  return new Command('init')
  .description('Scaffold a new Arachne YAML spec file')
  .option('-k, --kind <kind>', 'Artifact kind: agent, kb, or embedding-agent')
  .option('-n, --name <name>', 'Name for the artifact')
  .option('-f, --force', 'Overwrite existing file', false)
  .action(async (options: { kind?: string; name?: string; force: boolean }) => {
    let kind = options.kind as ArtifactKind | undefined;

    // Interactive prompt if --kind not provided
    if (!kind) {
      const answer = await promptInteractive(
        'What kind of artifact?',
        ['agent', 'kb', 'embedding-agent'],
      );
      if (!isValidKind(answer)) {
        console.error(`Error: invalid kind "${answer}". Choose: agent, kb, embedding-agent`);
        process.exit(1);
      }
      kind = answer;
    }

    if (!isValidKind(kind)) {
      console.error(`Error: invalid kind "${kind}". Choose: agent, kb, embedding-agent`);
      process.exit(1);
    }

    const name = options.name ?? DEFAULT_NAMES[kind];
    const filename = `${name}.yaml`;
    const filePath = resolve(filename);

    if (existsSync(filePath) && !options.force) {
      console.error(`Error: ${filename} already exists. Use --force to overwrite.`);
      process.exit(1);
    }

    const template = TEMPLATES[kind];
    const content = template(name);
    writeFileSync(filePath, content, 'utf8');

    console.log(`Created ${filename}`);
    console.log('');
    console.log('Next steps:');
    console.log(`  1. Edit ${filename} to customize your ${kind}`);
    console.log(`  2. Run: arachne weave ${filename}`);
    console.log(`  3. Run: arachne push dist/${name}.orb`);
  });
}

export const initCommand = createInitCommand();

function isValidKind(kind: string): kind is ArtifactKind {
  return kind === 'agent' || kind === 'kb' || kind === 'embedding-agent';
}

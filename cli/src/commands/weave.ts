import { Command } from 'commander';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'fs';
import { resolve, basename, dirname } from 'path';
import { getGatewayUrl, getToken } from '../config.js';
import { tarDirectory } from '../lib/zip.js';

interface SpecFields {
  kind: string;
  name: string;
  docsPath?: string;
}

function parseSpec(yaml: string): SpecFields {
  const kindMatch = yaml.match(/^kind:\s*(\S+)/m);
  const nameMatch = yaml.match(/^\s+name:\s*(\S+)/m);
  const docsPathMatch = yaml.match(/^\s+docsPath:\s*(\S+)/m);

  if (!kindMatch) throw new Error('Missing "kind" in spec YAML');
  if (!nameMatch) throw new Error('Missing "metadata.name" in spec YAML');

  return {
    kind: kindMatch[1].trim(),
    name: nameMatch[1].trim(),
    docsPath: docsPathMatch?.[1].trim(),
  };
}

export const weaveCommand = new Command('weave')
  .description('Weave a KnowledgeBase or Agent YAML spec into a signed artifact bundle')
  .argument('<spec>', 'Path to the YAML spec file (KnowledgeBase or Agent)')
  .option('-o, --output <dir>', 'Output directory for the bundle', 'dist')
  .action(async (specPath: string, options: { output: string }) => {
    let gatewayUrl: string;
    let token: string;
    try {
      gatewayUrl = getGatewayUrl();
      token = getToken();
    } catch {
      console.error("Error: not logged in. Run 'arachne login' first.");
      process.exit(1);
    }

    const specFile = resolve(specPath);
    const specContent = readFileSync(specFile, 'utf8');
    const { kind, name, docsPath } = parseSpec(specContent);

    const form = new FormData();
    form.append('spec', new Blob([specContent], { type: 'text/yaml' }), 'spec.yaml');

    if (docsPath) {
      const absDocsPath = resolve(dirname(specFile), docsPath);
      if (existsSync(absDocsPath)) {
        const stat = statSync(absDocsPath);
        if (stat.isDirectory()) {
          const tarBuf = await tarDirectory(absDocsPath);
          form.append('docs', new Blob([tarBuf], { type: 'application/gzip' }), 'docs.tgz');
        } else if (absDocsPath.endsWith('.zip')) {
          const buf = readFileSync(absDocsPath);
          form.append('docs', new Blob([buf], { type: 'application/zip' }), 'docs.zip');
        } else {
          const buf = readFileSync(absDocsPath);
          form.append('docs', new Blob([buf]), basename(absDocsPath));
        }
      }
    }

    const res = await fetch(`${gatewayUrl}/v1/registry/weave`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: form,
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`Error: ${res.status} ${body}`);
      process.exit(1);
    }

    const bundleBuf = Buffer.from(await res.arrayBuffer());
    const outDir = resolve(options.output);
    mkdirSync(outDir, { recursive: true });
    const outPath = resolve(outDir, `${name}.orb`);
    writeFileSync(outPath, bundleBuf);

    console.log(`✓ Wove ${kind} artifact → dist/${name}.orb`);
  });

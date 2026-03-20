/**
 * Minimal YAML parser for Arachne spec files.
 * Handles simple key-value pairs and nested objects.
 * Does NOT handle arrays, block scalars (|, >), or advanced YAML features.
 */

function parseYamlValue(raw: string): string | number | boolean | null {
  const stripped = raw.indexOf(' #') > 0 ? raw.slice(0, raw.indexOf(' #')).trim() : raw;
  if (stripped === 'true') return true;
  if (stripped === 'false') return false;
  if (stripped === 'null' || stripped === '~') return null;
  if (
    (stripped.startsWith('"') && stripped.endsWith('"')) ||
    (stripped.startsWith("'") && stripped.endsWith("'"))
  ) {
    return stripped.slice(1, -1);
  }
  if (/^-?\d+(\.\d+)?$/.test(stripped)) return Number(stripped);
  return stripped;
}

export function parseSimpleYaml(content: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const stack: Array<{ obj: Record<string, unknown>; indent: number }> = [
    { obj: root, indent: -1 },
  ];

  for (const line of content.split('\n')) {
    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const indent = line.length - trimmed.length;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const rawValue = trimmed.slice(colonIdx + 1).trim();

    // Pop stack until we find the correct parent scope
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    const parent = stack[stack.length - 1].obj;

    if (!rawValue || rawValue.startsWith('#')) {
      // Nested object
      const nested: Record<string, unknown> = {};
      parent[key] = nested;
      stack.push({ obj: nested, indent });
    } else {
      parent[key] = parseYamlValue(rawValue);
    }
  }

  return root;
}

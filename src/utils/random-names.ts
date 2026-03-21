const ADJECTIVES = ['brave', 'calm', 'eager', 'fair', 'gentle', 'happy', 'keen', 'lively', 'noble', 'proud',
  'quick', 'sharp', 'swift', 'warm', 'wise', 'bold', 'bright', 'cool', 'daring', 'fierce',
  'grand', 'honest', 'jolly', 'kind', 'lucky', 'merry', 'neat', 'patient', 'quiet', 'ready',
  'solid', 'tough', 'vivid', 'witty', 'able', 'agile', 'clever', 'crisp', 'deep', 'electric',
  'fresh', 'golden', 'humble', 'ivory', 'jade', 'keen', 'lunar', 'marble', 'olive', 'prime'];

const NOUNS = ['falcon', 'river', 'thunder', 'crystal', 'summit', 'phoenix', 'glacier', 'aurora', 'ember', 'coral',
  'cedar', 'meadow', 'harbor', 'prism', 'atlas', 'beacon', 'compass', 'delta', 'echo', 'forge',
  'grove', 'haven', 'iris', 'jetty', 'kite', 'lantern', 'mesa', 'nexus', 'orbit', 'pebble',
  'quartz', 'reef', 'sierra', 'tide', 'umbra', 'vale', 'wharf', 'zenith', 'arch', 'bloom',
  'crest', 'drift', 'flint', 'gale', 'haze', 'inlet', 'knoll', 'loom', 'marsh', 'oasis'];

export function generateRandomName(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adj}-${noun}`;
}

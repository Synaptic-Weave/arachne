/**
 * Unit tests for src/utils/slug.ts
 * Covers: generateOrgSlug, validateOrgSlug
 */

import { describe, it, expect } from 'vitest';
import { generateOrgSlug, validateOrgSlug } from '../src/utils/slug.js';

// ── generateOrgSlug ───────────────────────────────────────────────────────────

describe('generateOrgSlug', () => {
  it('lowercases and hyphenates a simple company name', () => {
    expect(generateOrgSlug('My Company')).toBe('my-company');
  });

  it('trims leading and trailing whitespace before slugifying', () => {
    expect(generateOrgSlug('  Spaces & Symbols!  ')).toBe('spaces-symbols');
  });

  it('collapses multiple consecutive special chars into a single hyphen', () => {
    expect(generateOrgSlug('Acme   Corp!!!')).toBe('acme-corp');
  });

  it('removes leading and trailing hyphens', () => {
    expect(generateOrgSlug('--Leading Hyphens--')).toBe('leading-hyphens');
  });

  it('handles parentheses and version strings', () => {
    expect(generateOrgSlug('My App (v2)')).toBe('my-app-v2');
  });

  it('handles already-slug-like input unchanged', () => {
    expect(generateOrgSlug('acme-corp')).toBe('acme-corp');
  });

  it('truncates to 50 characters', () => {
    const longName = 'A'.repeat(60);
    expect(generateOrgSlug(longName)).toHaveLength(50);
  });

  it('handles ampersand and special symbols', () => {
    expect(generateOrgSlug('Smith & Jones, LLC.')).toBe('smith-jones-llc');
  });
});

// ── validateOrgSlug ───────────────────────────────────────────────────────────

describe('validateOrgSlug', () => {
  it('returns valid: true for a well-formed slug', () => {
    expect(validateOrgSlug('valid-slug').valid).toBe(true);
  });

  it('returns valid: true for an all-numeric slug', () => {
    expect(validateOrgSlug('abc123').valid).toBe(true);
  });

  it('returns valid: false for UPPERCASE slug', () => {
    expect(validateOrgSlug('UPPERCASE').valid).toBe(false);
  });

  it('returns valid: false for slug with spaces', () => {
    expect(validateOrgSlug('has spaces').valid).toBe(false);
  });

  it('returns valid: false for empty string', () => {
    expect(validateOrgSlug('').valid).toBe(false);
  });

  it('returns valid: false for slug shorter than 3 chars', () => {
    expect(validateOrgSlug('ab').valid).toBe(false);
  });

  it('returns valid: false for slug longer than 50 chars', () => {
    expect(validateOrgSlug('a'.repeat(51)).valid).toBe(false);
  });

  it('returns valid: false for slug with leading hyphen', () => {
    expect(validateOrgSlug('-leading').valid).toBe(false);
  });

  it('returns valid: false for slug with trailing hyphen', () => {
    expect(validateOrgSlug('trailing-').valid).toBe(false);
  });

  it('returns valid: false for slug with underscore', () => {
    expect(validateOrgSlug('has_underscore').valid).toBe(false);
  });

  it('includes an error message when invalid', () => {
    const result = validateOrgSlug('');
    expect(result.valid).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('returns no error property when valid', () => {
    const result = validateOrgSlug('good-slug');
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('accepts exactly 3 character slug', () => {
    expect(validateOrgSlug('abc').valid).toBe(true);
  });

  it('accepts exactly 50 character slug', () => {
    expect(validateOrgSlug('a'.repeat(50)).valid).toBe(true);
  });
});

// ── extractFileFromTar ────────────────────────────────────────────────────────

import { extractFileFromTar } from '../src/utils/tar.js';

function buildTarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512);
  header.write(name.slice(0, 99), 0, 'utf8');
  header.write('0000644\0', 100, 'ascii');
  header.write('0000000\0', 108, 'ascii');
  header.write('0000000\0', 116, 'ascii');
  header.write(size.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
  header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136, 'ascii');
  header.fill(0x20, 148, 156);
  header.write('0', 156, 'ascii');
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 'ascii');
  let checksum = 0;
  for (let i = 0; i < 512; i++) checksum += header[i];
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return header;
}

function buildTestTar(files: Array<{ path: string; data: Buffer }>): Buffer {
  const blocks: Buffer[] = [];
  for (const file of files) {
    blocks.push(buildTarHeader(file.path, file.data.length));
    const padded = Buffer.alloc(Math.ceil(file.data.length / 512) * 512);
    file.data.copy(padded);
    blocks.push(padded);
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

describe('extractFileFromTar', () => {
  it('extracts a file by exact name', () => {
    const content = Buffer.from('{"hello":"world"}');
    const tar = buildTestTar([{ path: 'manifest.json', data: content }]);

    const result = extractFileFromTar(tar, 'manifest.json');
    expect(result).not.toBeNull();
    expect(result!.toString('utf8')).toBe('{"hello":"world"}');
  });

  it('extracts a nested file path', () => {
    const content = Buffer.from('chunk data');
    const tar = buildTestTar([
      { path: 'manifest.json', data: Buffer.from('{}') },
      { path: 'chunks/0.json', data: content },
    ]);

    const result = extractFileFromTar(tar, 'chunks/0.json');
    expect(result).not.toBeNull();
    expect(result!.toString('utf8')).toBe('chunk data');
  });

  it('returns null when file is not found', () => {
    const tar = buildTestTar([{ path: 'manifest.json', data: Buffer.from('{}') }]);
    const result = extractFileFromTar(tar, 'nonexistent.json');
    expect(result).toBeNull();
  });

  it('returns null for empty tar (just end-of-archive marker)', () => {
    const tar = Buffer.alloc(1024); // two zero blocks
    const result = extractFileFromTar(tar, 'anything');
    expect(result).toBeNull();
  });
});

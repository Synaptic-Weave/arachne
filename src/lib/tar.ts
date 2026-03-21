/**
 * Minimal tar reader for .orb bundles.
 * No external dependencies: uses only Node built-ins.
 */

/**
 * Extract a single file from a raw tar buffer by name.
 * Returns null if the file is not found.
 */
export function extractFileFromTar(tarBuf: Buffer, targetName: string): Buffer | null {
  let offset = 0;

  while (offset + 512 <= tarBuf.length) {
    const header = tarBuf.subarray(offset, offset + 512);

    // Check for end-of-archive (all zeros)
    let allZero = true;
    for (let i = 0; i < 512; i++) {
      if (header[i] !== 0) { allZero = false; break; }
    }
    if (allZero) break;

    // Read name (null-terminated, up to 100 bytes)
    let nameEnd = 0;
    while (nameEnd < 100 && header[nameEnd] !== 0) nameEnd++;
    const name = header.toString('utf8', 0, nameEnd);

    // Read size (octal, at offset 124, 12 bytes)
    const sizeStr = header.toString('ascii', 124, 136).replace(/\0/g, '').trim();
    const size = parseInt(sizeStr, 8) || 0;

    const dataStart = offset + 512;
    const paddedSize = Math.ceil(size / 512) * 512;

    if (name === targetName) {
      return tarBuf.subarray(dataStart, dataStart + size);
    }

    offset = dataStart + paddedSize;
  }

  return null;
}

/**
 * Extract multiple files from a raw tar buffer in a single pass.
 * Returns a Map of filename to Buffer for each found file.
 * Files not present in the tar are simply absent from the Map.
 */
export function extractFilesFromTar(tarBuf: Buffer, targetNames: string[]): Map<string, Buffer> {
  const targets = new Set(targetNames);
  const result = new Map<string, Buffer>();
  let offset = 0;

  while (offset + 512 <= tarBuf.length) {
    const header = tarBuf.subarray(offset, offset + 512);

    // Check for end-of-archive (all zeros)
    let allZero = true;
    for (let i = 0; i < 512; i++) {
      if (header[i] !== 0) { allZero = false; break; }
    }
    if (allZero) break;

    // Read name (null-terminated, up to 100 bytes)
    let nameEnd = 0;
    while (nameEnd < 100 && header[nameEnd] !== 0) nameEnd++;
    const name = header.toString('utf8', 0, nameEnd);

    // Read size (octal, at offset 124, 12 bytes)
    const sizeStr = header.toString('ascii', 124, 136).replace(/\0/g, '').trim();
    const size = parseInt(sizeStr, 8) || 0;

    const dataStart = offset + 512;
    const paddedSize = Math.ceil(size / 512) * 512;

    if (targets.has(name)) {
      result.set(name, tarBuf.subarray(dataStart, dataStart + size));
      if (result.size === targets.size) break; // found all targets
    }

    offset = dataStart + paddedSize;
  }

  return result;
}

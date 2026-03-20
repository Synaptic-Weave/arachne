/**
 * Minimal tar builder/reader for .orb bundles.
 * No external dependencies: uses only Node built-ins.
 */

function buildTarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512);

  // name (100 bytes)
  header.write(name.slice(0, 99), 0, 'utf8');
  // mode
  header.write('0000644\0', 100, 'ascii');
  // uid
  header.write('0000000\0', 108, 'ascii');
  // gid
  header.write('0000000\0', 116, 'ascii');
  // size (12 bytes, octal)
  header.write(size.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
  // mtime (12 bytes, octal)
  header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136, 'ascii');
  // checksum placeholder (8 spaces)
  header.fill(0x20, 148, 156);
  // typeflag: regular file
  header.write('0', 156, 'ascii');
  // magic: ustar\0
  header.write('ustar\0', 257, 'ascii');
  // version: 00
  header.write('00', 263, 'ascii');

  // Compute and write checksum
  let checksum = 0;
  for (let i = 0; i < 512; i++) checksum += header[i]!;
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');

  return header;
}

export function buildTar(files: Array<{ path: string; data: Buffer }>): Buffer {
  const blocks: Buffer[] = [];

  for (const file of files) {
    blocks.push(buildTarHeader(file.path, file.data.length));
    // Pad data to 512-byte boundary
    const padded = Buffer.alloc(Math.ceil(file.data.length / 512) * 512);
    file.data.copy(padded);
    blocks.push(padded);
  }

  // End-of-archive marker: two 512-byte zero blocks
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

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

/**
 * Minimal tar extraction utility (pure Buffer manipulation, no dependencies).
 * Reads POSIX/ustar tar archives to extract individual files by name.
 */

/**
 * Extract a single file from a raw (uncompressed) tar buffer.
 * Returns the file content as a Buffer, or null if the file is not found.
 */
export function extractFileFromTar(tarBuf: Buffer, targetName: string): Buffer | null {
  let offset = 0;

  while (offset + 512 <= tarBuf.length) {
    const header = tarBuf.subarray(offset, offset + 512);

    // End-of-archive: two consecutive zero blocks
    if (header.every((b) => b === 0)) break;

    // File name: first 100 bytes, null-terminated
    const nameEnd = header.indexOf(0, 0);
    const name = header.subarray(0, nameEnd > 0 && nameEnd < 100 ? nameEnd : 100).toString('utf8');

    // File size: 12 bytes at offset 124, octal, null/space terminated
    const sizeStr = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeStr, 8) || 0;

    // Data starts in the next 512-byte block
    const dataOffset = offset + 512;
    const paddedSize = Math.ceil(size / 512) * 512;

    if (name === targetName) {
      return tarBuf.subarray(dataOffset, dataOffset + size);
    }

    offset = dataOffset + paddedSize;
  }

  return null;
}

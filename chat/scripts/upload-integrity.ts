/** Return the first upload chunk whose current bytes differ from the model.
 * Headers contain chain-specific authority/seal fields and are checked separately.
 * Matching bytes beyond a saved checkpoint are recovered after interrupted runs. */
export function matchingUploadPrefix(
  expected: Uint8Array,
  actual: Uint8Array,
  chunkBytes = 3760,
) {
  if (expected.length !== actual.length || expected.length < 128 ||
      !Number.isSafeInteger(chunkBytes) || chunkBytes < 1)
    throw new Error("Invalid upload comparison");
  const want = Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength);
  const have = Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength);
  for (let offset = 128; offset < want.length; offset += chunkBytes) {
    const end = Math.min(offset + chunkBytes, want.length);
    if (!want.subarray(offset, end).equals(have.subarray(offset, end))) return offset;
  }
  return want.length;
}

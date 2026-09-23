/** Wire constants shared with inference/program/src/layout.rs. */
export const MODEL = "Qwen/Qwen3-8B";
export const DIM = 4096,
  KV_DIM = 1024,
  FFN = 12288,
  VOCAB = 151936,
  LAYERS = 36;
export const LANES = 16,
  MAX_SEQ = 128,
  STATE_SIZE = 9_971_712,
  LANE_SIZE = 648;
export type Header = {
  phase: number;
  layer: number;
  position: number;
  cursor: number;
  epoch: number;
  token: number;
  count: number;
};
export type Shard = {
  address: string;
  tensor: number;
  rowStart: number;
  rows: number;
  cols: number;
  size: number;
  encoding: number;
};
export function header(bytes: Uint8Array): Header {
  if (
    bytes.length < 144 ||
    new TextDecoder().decode(bytes.slice(0, 8)) !== "SEACHAT2"
  )
    throw new Error("Invalid session account");
  const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    phase: d.getUint32(104, true),
    layer: d.getUint32(108, true),
    position: d.getUint32(112, true),
    cursor: d.getUint32(116, true),
    epoch: d.getUint32(120, true),
    token: d.getUint32(128, true),
    count: d.getUint32(136, true),
  };
}
export const parallel = (phase: number) =>
  [3, 5, 6, 8, 9, 10, 13].includes(phase);
export const stride = (phase: number) => (phase === 5 ? 1 : 128);
export function total(h: Header): number {
  switch (h.phase) {
    case 3:
      return DIM + 2 * KV_DIM;
    case 5:
      return 32 * Math.ceil((h.position + 1) / 16);
    case 6:
    case 10:
      return DIM;
    case 8:
      return 2 * FFN;
    case 9:
      return FFN;
    case 13:
      return VOCAB;
    default:
      throw new Error(`Phase ${h.phase} has no parallel work`);
  }
}
export function tensorFor(
  h: Header,
  row = h.cursor,
): [number, number] | undefined {
  const base = 3 + h.layer * 8;
  switch (h.phase) {
    case 1:
      return [0, h.token];
    case 2:
    case 4:
    case 7:
      return [base, 0];
    case 12:
      return [1, 0];
    case 3:
      return row < DIM
        ? [base + 1, row]
        : row < DIM + KV_DIM
          ? [base + 2, row - DIM]
          : [base + 3, row - DIM - KV_DIM];
    case 6:
      return [base + 4, row];
    case 8:
      return row < FFN ? [base + 5, row] : [base + 6, row - FFN];
    case 10:
      return [base + 7, row];
    case 13:
      return [2, row];
  }
}
export function descriptor(
  shards: Shard[],
  tuple?: [number, number],
): number | undefined {
  if (!tuple) return undefined;
  const [tensor, row] = tuple;
  const index = shards.findIndex(
    (s) =>
      s.tensor === tensor && s.rowStart <= row && row < s.rowStart + s.rows,
  );
  if (index < 0) throw new Error(`Missing tensor ${tensor}, row ${row}`);
  return index;
}
export function epochData(
  op: number,
  epoch: number,
  descriptor?: number,
): Uint8Array {
  const bytes = new Uint8Array(descriptor === undefined ? 5 : 7);
  const view = new DataView(bytes.buffer);
  bytes[0] = op;
  view.setUint32(1, epoch, true);
  if (descriptor !== undefined) view.setUint16(5, descriptor, true);
  return bytes;
}

export const tileChunk = (phase: number) =>
  phase === 5 ? 1 : phase === 9 ? 128 : phase === 10 ? 8 : 24;

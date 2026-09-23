// Full Qwen3-8B architecture. Storage is quantized; dimensions are not reduced.
pub const DIM: usize = 4096;
pub const KV_DIM: usize = 1024;
pub const FFN: usize = 12288;
pub const LAYERS: usize = 36;
pub const VOCAB: usize = 151936;
pub const HEADS: usize = 32;
pub const KV_HEADS: usize = 8;
pub const HEAD_DIM: usize = 128;
pub const MAX_SEQ: usize = 128;
pub const GROUP: usize = 128;
pub const TILE: usize = 16;
pub const LANES: usize = 16;
pub const ATTN_CHUNK: usize = 16;
pub const BLOB_HEADER: usize = 128;
pub const DESCRIPTOR: usize = 64;
pub const LANE_SIZE: usize = 128 + (HEAD_DIM + 2) * 4;
pub const TOKENS: usize = 256;
pub const FLOATS: usize = TOKENS + MAX_SEQ * 4;
pub const H: usize = 0;
pub const Q: usize = DIM;
pub const K: usize = 2 * DIM;
pub const V: usize = K + KV_DIM;
pub const ATTN: usize = V + KV_DIM;
pub const OUT: usize = ATTN + DIM;
pub const GATE: usize = OUT + DIM;
pub const UP: usize = GATE + FFN;
pub const ACT: usize = UP + FFN;
pub const ATTN_META: usize = ACT + FFN;
pub const ROPE_SIN: usize = ATTN_META + HEADS * 2;
pub const ROPE_COS: usize = ROPE_SIN + HEAD_DIM / 2;
pub const QUANT: usize = FLOATS + (ROPE_COS + HEAD_DIM / 2) * 4;
pub const SCALES: usize = QUANT + FFN;
pub const QUERY: usize = SCALES + FFN / GROUP * 4;
pub const QUERY_SCALES: usize = QUERY + DIM;
pub const KV: usize = QUERY_SCALES + HEADS * 4;
pub const CACHE_HEAD: usize = HEAD_DIM + 4;
pub const STATE_SIZE: usize = KV + LAYERS * MAX_SEQ * KV_HEADS * CACHE_HEAD * 2;
pub const MAX_ACCOUNT: usize = 10 * 1024 * 1024;

pub fn u32_at(d: &[u8], o: usize) -> u32 {
    u32::from_le_bytes(d[o..o + 4].try_into().unwrap())
}
pub fn set_u32(d: &mut [u8], o: usize, v: u32) {
    d[o..o + 4].copy_from_slice(&v.to_le_bytes());
}
pub fn f32_at(d: &[u8], o: usize) -> f32 {
    f32::from_le_bytes(d[o..o + 4].try_into().unwrap())
}
pub fn set_f32(d: &mut [u8], o: usize, v: f32) {
    d[o..o + 4].copy_from_slice(&v.to_le_bytes());
}
pub fn f(d: &[u8], i: usize) -> f32 {
    f32_at(d, FLOATS + i * 4)
}
pub fn put(d: &mut [u8], i: usize, v: f32) {
    set_f32(d, FLOATS + i * 4, v);
}
pub fn cache(layer: usize, pos: usize, head: usize, value: bool) -> usize {
    KV + ((layer * MAX_SEQ + pos) * KV_HEADS * 2 + if value { KV_HEADS } else { 0 } + head)
        * CACHE_HEAD
}
pub fn row_bytes(cols: usize) -> usize {
    cols / GROUP * 66
}
// Header: magic[8], authority[32], registry[32], reserved[32], phase@104,
// layer@108, pos@112, cursor@116, epoch@120, token@128, emit@132,
// token_count@136, best_logit@140. Every work result binds session+epoch.

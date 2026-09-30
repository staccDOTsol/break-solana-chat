use crate::layout::*;

pub fn half(bytes: &[u8]) -> f32 {
    let bits = u16::from_le_bytes([bytes[0], bytes[1]]) as u32;
    let sign = (bits & 0x8000) << 16;
    let exponent = (bits >> 10) & 31;
    let fraction = bits & 1023;
    if exponent == 0 {
        f32::from_bits(sign)
            + (if sign == 0 { 1.0 } else { -1.0 }) * fraction as f32 * (1.0 / 16_777_216.0)
    } else if exponent == 31 {
        f32::from_bits(sign | 0x7f800000 | fraction << 13)
    } else {
        f32::from_bits(sign | ((exponent + 112) << 23) | fraction << 13)
    }
}
#[inline(always)]
fn dot_packed64(w: &[u8], x: &[u8]) -> i32 {
    let w: &[u8; 64] = w.try_into().unwrap();
    let x: &[u8; 128] = x.try_into().unwrap();
    macro_rules! dot { ($($i:literal),*) => { 0 $(+
        ((w[$i] << 4) as i8 as i32 >> 4) * (x[$i * 2] as i8 as i32)
        + (w[$i] as i8 as i32 >> 4) * (x[$i * 2 + 1] as i8 as i32))* }; }
    dot!(
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
        25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47,
        48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63
    )
}
pub fn matrow(weights: &[u8], sd: &[u8], cols: usize) -> f32 {
    let mut value = 0.0;
    for g in 0..cols / GROUP {
        let w = &weights[g * 66..(g + 1) * 66];
        let dot = dot_packed64(&w[2..], &sd[QUANT + g * GROUP..QUANT + (g + 1) * GROUP]);
        value += dot as f32 * half(w) * f32_at(sd, SCALES + g * 4);
    }
    value
}
pub fn embed(sd: &mut [u8], row: &[u8]) {
    for g in 0..DIM / GROUP {
        let w = &row[g * 66..(g + 1) * 66];
        let scale = half(w);
        for i in 0..64 {
            put(
                sd,
                H + g * GROUP + 2 * i,
                ((w[2 + i] << 4) as i8 >> 4) as f32 * scale,
            );
            put(
                sd,
                H + g * GROUP + 2 * i + 1,
                (w[2 + i] as i8 >> 4) as f32 * scale,
            );
        }
    }
}
pub fn quantize(sd: &mut [u8], start: usize, first: usize, n: usize) {
    for g in first / GROUP..(first + n) / GROUP {
        let mut max = 0.0f32;
        for i in 0..GROUP {
            max = max.max(f(sd, start + g * GROUP + i).abs());
        }
        let scale = if max > 0.0 { max / 127.0 } else { 1.0 };
        let inv = 1.0 / scale;
        for i in 0..GROUP {
            sd[QUANT + g * GROUP + i] = (f(sd, start + g * GROUP + i) * inv)
                .round()
                .clamp(-127.0, 127.0) as i8 as u8;
        }
        set_f32(sd, SCALES + g * 4, scale);
    }
}
pub fn norm_prepare(sd: &mut [u8]) {
    let mut sum = 0.0f32;
    for i in 0..DIM {
        let x = f(sd, H + i);
        sum += x * x;
    }
    set_f32(sd, 144, 1.0 / libm::sqrtf(sum / DIM as f32 + 1e-6));
}
pub fn norm_part(sd: &mut [u8], weights: &[u8], offset: usize, start: usize) {
    let inv = f32_at(sd, 144);
    for i in start..start + 1024 {
        put(
            sd,
            OUT + i,
            f(sd, H + i) * inv * f32_at(weights, offset + i * 4),
        );
    }
    quantize(sd, OUT, start, 1024);
}
pub fn rope_prepare(sd: &mut [u8], pos: usize) {
    for i in 0..HEAD_DIM / 2 {
        let angle = pos as f32 * libm::powf(1_000_000.0, -((2 * i) as f32) / HEAD_DIM as f32);
        let (sin, cos) = libm::sincosf(angle);
        put(sd, ROPE_SIN + i, sin);
        put(sd, ROPE_COS + i, cos);
    }
}
pub fn rope_part(sd: &mut [u8], weights: &[u8], layer: usize, pos: usize, start: usize) {
    for task in start..start + 8 {
        let (base, head, offset) = if task < HEADS {
            (Q, task, BLOB_HEADER + DIM * 8)
        } else if task < HEADS + KV_HEADS {
            (K, task - HEADS, BLOB_HEADER + DIM * 8 + HEAD_DIM * 4)
        } else {
            (V, task - HEADS - KV_HEADS, 0)
        };
        if base != V {
            let mut sum = 0.0f32;
            for i in 0..HEAD_DIM {
                let x = f(sd, base + head * HEAD_DIM + i);
                sum += x * x;
            }
            let inv = 1.0 / libm::sqrtf(sum / HEAD_DIM as f32 + 1e-6);
            for i in 0..HEAD_DIM {
                let j = base + head * HEAD_DIM + i;
                put(sd, j, f(sd, j) * inv * f32_at(weights, offset + i * 4));
            }
            for i in 0..HEAD_DIM / 2 {
                let (sin, cos) = (f(sd, ROPE_SIN + i), f(sd, ROPE_COS + i));
                let j = base + head * HEAD_DIM + i;
                let (a, b) = (f(sd, j), f(sd, j + HEAD_DIM / 2));
                put(sd, j, a * cos - b * sin);
                put(sd, j + HEAD_DIM / 2, b * cos + a * sin);
            }
        }
        let mut max = 0.0f32;
        for i in 0..HEAD_DIM {
            max = max.max(f(sd, base + head * HEAD_DIM + i).abs());
        }
        let scale = if max > 0.0 { max / 127.0 } else { 1.0 };
        let inv = 1.0 / scale;
        let dest = if base == Q {
            QUERY + head * HEAD_DIM
        } else {
            cache(layer, pos, head, base == V) + 4
        };
        for i in 0..HEAD_DIM {
            sd[dest + i] = (f(sd, base + head * HEAD_DIM + i) * inv)
                .round()
                .clamp(-127.0, 127.0) as i8 as u8;
        }
        set_f32(
            sd,
            if base == Q {
                QUERY_SCALES + head * 4
            } else {
                dest - 4
            },
            scale,
        );
    }
}
/// Stable partial softmax. Cached K/V and Q use per-head symmetric INT8.
pub fn attention(sd: &[u8], ld: &mut [u8], task: usize, layer: usize, pos: usize) {
    let chunks = (pos + 1).div_ceil(ATTN_CHUNK);
    let head = task / chunks;
    let start = (task % chunks) * ATTN_CHUNK;
    let end = (start + ATTN_CHUNK).min(pos + 1);
    let mut scores = [0.0f32; ATTN_CHUNK];
    let mut max = f32::NEG_INFINITY;
    for p in start..end {
        let k = cache(layer, p, head / (HEADS / KV_HEADS), false);
        let mut dot = 0i32;
        for i in 0..HEAD_DIM {
            dot += sd[QUERY + head * HEAD_DIM + i] as i8 as i32 * sd[k + 4 + i] as i8 as i32;
        }
        let score =
            dot as f32 * f32_at(sd, QUERY_SCALES + head * 4) * f32_at(sd, k) * 0.08838834764831845;
        scores[p - start] = score;
        max = max.max(score);
    }
    let mut sum = 0.0f32;
    for score in &mut scores[..end - start] {
        *score = libm::expf(*score - max);
        sum += *score;
    }
    for i in 0..HEAD_DIM {
        let mut value = 0.0f32;
        for p in start..end {
            let v = cache(layer, p, head / (HEADS / KV_HEADS), true);
            value += scores[p - start] * (sd[v + 4 + i] as i8 as f32 * f32_at(sd, v));
        }
        set_f32(ld, 128 + i * 4, value);
    }
    set_f32(ld, 128 + HEAD_DIM * 4, max);
    set_f32(ld, 132 + HEAD_DIM * 4, sum);
}

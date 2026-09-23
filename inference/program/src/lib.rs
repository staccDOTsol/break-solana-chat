use solana_program::{
    account_info::AccountInfo, entrypoint::ProgramResult, program_error::ProgramError as E,
    pubkey::Pubkey,
};
pub mod layout;
pub mod math;
use layout::*;

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

fn check(ok: bool) -> ProgramResult {
    if ok {
        Ok(())
    } else {
        Err(E::InvalidAccountData)
    }
}
fn owned(pid: &Pubkey, a: &AccountInfo, size: usize) -> ProgramResult {
    check(a.owner == pid && a.data_len() == size)
}
fn signed(a: &AccountInfo) -> ProgramResult {
    if a.is_signer {
        Ok(())
    } else {
        Err(E::MissingRequiredSignature)
    }
}
fn state(pid: &Pubkey, a: &AccountInfo, auth: &AccountInfo) -> ProgramResult {
    owned(pid, a, STATE_SIZE)?;
    signed(auth)?;
    let d = a.try_borrow_data()?;
    check(&d[..8] == b"SEACHAT2" && &d[8..40] == auth.key.as_ref())
}
fn registry(pid: &Pubkey, a: &AccountInfo) -> ProgramResult {
    check(a.owner == pid && a.data_len() >= BLOB_HEADER)?;
    let d = a.try_borrow_data()?;
    let n = u32_at(&d, 48) as usize;
    check(
        &d[..8] == b"SEABLOB2"
            && d[8] == 1
            && d[9] == 1
            && n > 0
            && n <= 1024
            && d.len() == BLOB_HEADER + n * DESCRIPTOR,
    )
}
fn model(pid: &Pubkey, a: &AccountInfo, sd: &[u8]) -> ProgramResult {
    check(&sd[40..72] == a.key.as_ref())?;
    registry(pid, a)
}
// A descriptor fixes the address, tensor identity, shape, encoding and range.
// The client supplies its index; selecting another blob cannot change the math.
fn blob(
    pid: &Pubkey,
    a: &AccountInfo,
    registry: &AccountInfo,
    index: usize,
    tensor: usize,
    start: usize,
    end: usize,
    cols: usize,
    encoding: u32,
) -> Result<usize, E> {
    let md = registry.try_borrow_data()?;
    check(index < u32_at(&md, 48) as usize)?;
    let desc = &md[BLOB_HEADER + index * DESCRIPTOR..BLOB_HEADER + (index + 1) * DESCRIPTOR];
    check(
        &desc[..32] == a.key.as_ref()
            && u32_at(desc, 32) as usize == tensor
            && u32_at(desc, 44) as usize == cols
            && u32_at(desc, 48) == encoding,
    )?;
    let first = u32_at(desc, 36) as usize;
    let rows = u32_at(desc, 40) as usize;
    let stride = if encoding == 1 { row_bytes(cols) } else { 4 };
    check(first <= start && start < end && end <= first + rows && a.data_len() <= MAX_ACCOUNT)?;
    owned(pid, a, BLOB_HEADER + rows * stride)?;
    let d = a.try_borrow_data()?;
    check(&d[..8] == b"SEABLOB2" && d[8] == 1 && d[9] == 0 && d[48..68] == desc[32..52])?;
    Ok(first)
}
fn descriptor(data: &[u8]) -> usize {
    u16::from_le_bytes([data[4], data[5]]) as usize
}
fn bump(sd: &mut [u8]) -> ProgramResult {
    let next = u32_at(sd, 120)
        .checked_add(1)
        .ok_or(E::ArithmeticOverflow)?;
    set_u32(sd, 120, next);
    Ok(())
}
fn phase(sd: &mut [u8], p: u32) {
    set_u32(sd, 104, p);
    set_u32(sd, 116, 0);
    set_u32(sd, 120, u32_at(sd, 120) + 1);
}
fn total(sd: &[u8]) -> usize {
    match u32_at(sd, 104) {
        3 => DIM + 2 * KV_DIM,
        5 => HEADS * (u32_at(sd, 112) as usize + 1).div_ceil(ATTN_CHUNK),
        6 | 10 => DIM,
        8 => FFN * 2,
        9 => FFN,
        13 => VOCAB,
        _ => 0,
    }
}
fn stride(sd: &[u8]) -> usize {
    match u32_at(sd, 104) {
        5 => 1,
        _ => 128,
    }
}

pub fn process_instruction(pid: &Pubkey, a: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let (&op, data) = data.split_first().ok_or(E::InvalidInstructionData)?;
    match op {
        // Blob creation/write/seal. Only the blob's recorded uploader can write;
        // inference accepts sealed blobs only. These cannot mutate chat accounts.
        90..=92 => upload(pid, a, op, data),
        0 => init(pid, a),
        1 => init_lane(pid, a, data),
        2 => start(pid, a, data),
        3 => advance(pid, a, data),
        4 => tile(pid, a, data),
        5 => merge(pid, a, data),
        6 => close(pid, a),
        _ => Err(E::InvalidInstructionData),
    }
}

fn upload(pid: &Pubkey, a: &[AccountInfo], op: u8, data: &[u8]) -> ProgramResult {
    check(a.len() == 2 && a[0].owner == pid && a[0].is_writable)?;
    signed(&a[1])?;
    let mut d = a[0].try_borrow_mut_data()?;
    check(d.len() >= BLOB_HEADER)?;
    if op == 90 {
        signed(&a[0])?;
        check(data.len() == 21 && d.iter().take(BLOB_HEADER).all(|b| *b == 0))?;
        let rows = u32_at(data, 9) as usize;
        let cols = u32_at(data, 13) as usize;
        let encoding = u32_at(data, 17);
        let size = if data[0] == 1 {
            let count = u32_at(data, 1) as usize;
            check(count > 0 && count <= 1024 && data[5..].iter().all(|x| *x == 0))?;
            BLOB_HEADER + count * DESCRIPTOR
        } else {
            check(
                data[0] == 0
                    && rows > 0
                    && rows <= VOCAB
                    && cols > 0
                    && cols <= FFN
                    && encoding <= 1,
            )?;
            check(encoding == 0 && cols == 1 || encoding == 1 && cols % GROUP == 0)?;
            BLOB_HEADER + rows * if encoding == 1 { row_bytes(cols) } else { 4 }
        };
        check(d.len() == size && size <= MAX_ACCOUNT)?;
        d[..8].copy_from_slice(b"SEABLOB2");
        d[9] = data[0];
        d[16..48].copy_from_slice(a[1].key.as_ref());
        d[48..68].copy_from_slice(&data[1..21]);
    } else {
        check(&d[..8] == b"SEABLOB2" && d[8] == 0 && &d[16..48] == a[1].key.as_ref())?;
        if op == 91 {
            check(data.len() >= 4)?;
            let offset = u32_at(data, 0) as usize;
            let end = offset
                .checked_add(data.len() - 4)
                .ok_or(E::InvalidInstructionData)?;
            check(offset >= BLOB_HEADER && end <= d.len())?;
            d[offset..end].copy_from_slice(&data[4..]);
        } else {
            check(data.is_empty())?;
            d[8] = 1;
        }
    }
    Ok(())
}

fn init(pid: &Pubkey, a: &[AccountInfo]) -> ProgramResult {
    check(a.len() == 3)?;
    owned(pid, &a[0], STATE_SIZE)?;
    signed(&a[0])?;
    signed(&a[1])?;
    registry(pid, &a[2])?;
    let mut sd = a[0].try_borrow_mut_data()?;
    check(sd[..8] == [0; 8])?;
    sd[..8].copy_from_slice(b"SEACHAT2");
    sd[8..40].copy_from_slice(a[1].key.as_ref());
    sd[40..72].copy_from_slice(a[2].key.as_ref());
    Ok(())
}
fn init_lane(pid: &Pubkey, a: &[AccountInfo], data: &[u8]) -> ProgramResult {
    check(a.len() == 3 && data.len() == 1 && (data[0] as usize) < LANES)?;
    owned(pid, &a[0], LANE_SIZE)?;
    signed(&a[0])?;
    state(pid, &a[1], &a[2])?;
    let mut d = a[0].try_borrow_mut_data()?;
    check(d[..8] == [0; 8])?;
    d[..8].copy_from_slice(b"SEALANE2");
    d[8..40].copy_from_slice(a[1].key.as_ref());
    set_u32(&mut d, 40, data[0] as u32);
    set_u32(&mut d, 44, u32::MAX);
    Ok(())
}
fn start(pid: &Pubkey, a: &[AccountInfo], data: &[u8]) -> ProgramResult {
    check(a.len() == 2 && data.len() == 9 && data[4] <= 1)?;
    state(pid, &a[0], &a[1])?;
    let mut sd = a[0].try_borrow_mut_data()?;
    check(u32_at(data, 5) == u32_at(&sd, 120))?;
    let p = u32_at(&sd, 104);
    let len = u32_at(&sd, 136) as usize;
    let token = u32_at(data, 0);
    check((p == 0 || p == 14) && len < MAX_SEQ && token < VOCAB as u32)?;
    set_u32(&mut sd, TOKENS + len * 4, token);
    set_u32(&mut sd, 112, len as u32);
    set_u32(&mut sd, 136, (len + 1) as u32);
    set_u32(&mut sd, 132, data[4] as u32);
    set_u32(&mut sd, 108, 0);
    set_u32(&mut sd, 128, token);
    set_f32(&mut sd, 140, f32::NEG_INFINITY);
    phase(&mut sd, 1);
    Ok(())
}

fn advance(pid: &Pubkey, a: &[AccountInfo], data: &[u8]) -> ProgramResult {
    check(a.len() >= 3 && data.len() == 6)?;
    state(pid, &a[0], &a[1])?;
    let mut sd = a[0].try_borrow_mut_data()?;
    model(pid, &a[2], &sd)?;
    check(u32_at(data, 0) == u32_at(&sd, 120))?;
    let p = u32_at(&sd, 104);
    let layer = u32_at(&sd, 108) as usize;
    let pos = u32_at(&sd, 112) as usize;
    match p {
        1 => {
            check(a.len() == 4)?;
            let token = u32_at(&sd, 128) as usize;
            let first = blob(
                pid,
                &a[3],
                &a[2],
                descriptor(data),
                0,
                token,
                token + 1,
                DIM,
                1,
            )?;
            let sh = a[3].try_borrow_data()?;
            let row = BLOB_HEADER + (token - first) * row_bytes(DIM);
            math::embed(&mut sd, &sh[row..row + row_bytes(DIM)]);
            phase(&mut sd, 2);
        }
        2 | 7 | 12 => {
            check(a.len() == 4)?;
            let tensor = if p == 12 { 1 } else { 3 + layer * 8 };
            let rows = if p == 12 { DIM } else { DIM * 2 + HEAD_DIM * 2 };
            blob(pid, &a[3], &a[2], descriptor(data), tensor, 0, rows, 1, 0)?;
            let stage = u32_at(&sd, 116) as usize;
            check(stage <= DIM / 1024)?;
            if stage == 0 {
                if p == 7 {
                    for i in 0..DIM {
                        let value = f(&sd, H + i) + f(&sd, OUT + i);
                        put(&mut sd, H + i, value);
                    }
                }
                math::norm_prepare(&mut sd);
            } else {
                math::norm_part(
                    &mut sd,
                    &a[3].try_borrow_data()?,
                    BLOB_HEADER + if p == 7 { DIM * 4 } else { 0 },
                    (stage - 1) * 1024,
                );
            }
            if stage == DIM / 1024 {
                phase(&mut sd, p + 1);
            } else {
                set_u32(&mut sd, 116, (stage + 1) as u32);
                bump(&mut sd)?;
            }
        }
        4 => {
            check(a.len() == 4)?;
            blob(
                pid,
                &a[3],
                &a[2],
                descriptor(data),
                3 + layer * 8,
                0,
                DIM * 2 + HEAD_DIM * 2,
                1,
                0,
            )?;
            let stage = u32_at(&sd, 116) as usize;
            check(stage <= 6)?;
            if stage == 0 {
                math::rope_prepare(&mut sd, pos);
            } else {
                math::rope_part(
                    &mut sd,
                    &a[3].try_borrow_data()?,
                    layer,
                    pos,
                    (stage - 1) * 8,
                );
            }
            if stage == 6 {
                for i in 0..DIM {
                    put(&mut sd, ATTN + i, 0.0);
                }
                for head in 0..HEADS {
                    put(&mut sd, ATTN_META + 2 * head, f32::NEG_INFINITY);
                    put(&mut sd, ATTN_META + 2 * head + 1, 0.0);
                }
                phase(&mut sd, 5);
            } else {
                set_u32(&mut sd, 116, (stage + 1) as u32);
                bump(&mut sd)?;
            }
        }
        15 | 16 => {
            let cursor = u32_at(&sd, 116) as usize;
            let (source, n, next) = if p == 15 {
                (ATTN, DIM, 6)
            } else {
                (ACT, FFN, 10)
            };
            check(cursor < n && cursor % 1024 == 0)?;
            math::quantize(&mut sd, source, cursor, 1024);
            if cursor + 1024 == n {
                phase(&mut sd, next);
            } else {
                set_u32(&mut sd, 116, (cursor + 1024) as u32);
                bump(&mut sd)?;
            }
        }
        11 => {
            for i in 0..DIM {
                let value = f(&sd, H + i) + f(&sd, OUT + i);
                put(&mut sd, H + i, value);
            }
            if layer + 1 < LAYERS {
                set_u32(&mut sd, 108, (layer + 1) as u32);
                phase(&mut sd, 2);
            } else {
                let emit = u32_at(&sd, 132);
                phase(&mut sd, if emit == 1 { 12 } else { 0 });
            }
        }
        _ => return Err(E::InvalidInstructionData),
    }
    Ok(())
}

fn tile(pid: &Pubkey, a: &[AccountInfo], data: &[u8]) -> ProgramResult {
    check(a.len() >= 4 && data.len() == 8)?;
    state(pid, &a[0], &a[2])?;
    owned(pid, &a[1], LANE_SIZE)?;
    let sd = a[0].try_borrow_data()?;
    model(pid, &a[3], &sd)?;
    let mut ld = a[1].try_borrow_mut_data()?;
    check(&ld[..8] == b"SEALANE2" && &ld[8..40] == a[0].key.as_ref())?;
    let epoch = u32_at(&sd, 120);
    check(u32_at(data, 0) == epoch)?;
    let p = u32_at(&sd, 104);
    let layer = u32_at(&sd, 108) as usize;
    let index = u32_at(&ld, 40) as usize;
    check(index < LANES)?;
    let start = u32_at(&sd, 116) as usize + index * stride(&sd);
    let end = (start + stride(&sd)).min(total(&sd));
    check(start < end)?;
    let part = u16::from_le_bytes([data[6], data[7]]) as usize;
    let chunk = match p {
        5 => 1,
        9 => 128,
        10 => 8,
        _ => 24,
    };
    check(part < end - start && part % chunk == 0)?;
    let part_end = (part + chunk).min(end - start);
    if u32_at(&ld, 44) == epoch {
        check(u32_at(&ld, 48) == p && u32_at(&ld, 52) as usize == start)?;
        let processed = u32_at(&ld, 60) as usize;
        // Retries of an already completed slice cannot count as new work.
        if processed >= part_end {
            return Ok(());
        }
        check(processed == part)?;
    } else {
        check(part == 0)?;
    }
    if p == 5 {
        math::attention(&sd, &mut ld, start, layer, u32_at(&sd, 112) as usize);
    } else if p == 9 {
        for row in start..end {
            let gate = f(&sd, GATE + row);
            set_f32(
                &mut ld,
                128 + (row - start) * 4,
                gate / (1.0 + libm::expf(-gate)) * f(&sd, UP + row),
            );
        }
    } else {
        check(a.len() == 5 && matches!(p, 3 | 6 | 8 | 10 | 13))?;
        let (kind, local, limit) = match p {
            3 if start < DIM => (1, start, DIM),
            3 if start < DIM + KV_DIM => (2, start - DIM, DIM + KV_DIM),
            3 => (3, start - DIM - KV_DIM, DIM + 2 * KV_DIM),
            6 => (4, start, DIM),
            8 if start < FFN => (5, start, FFN),
            8 => (6, start - FFN, FFN * 2),
            10 => (7, start, DIM),
            13 => (0, start, VOCAB),
            _ => unreachable!(),
        };
        check(end <= limit)?;
        let cols = if p == 10 { FFN } else { DIM };
        let tensor = if p == 13 { 2 } else { 3 + layer * 8 + kind };
        let first = blob(
            pid,
            &a[4],
            &a[3],
            descriptor(data),
            tensor,
            local,
            local + end - start,
            cols,
            1,
        )?;
        let sh = a[4].try_borrow_data()?;
        let row_size = row_bytes(cols);
        for i in part..part_end {
            let offset = BLOB_HEADER + (local + i - first) * row_size;
            set_f32(
                &mut ld,
                128 + i * 4,
                math::matrow(&sh[offset..offset + row_size], &sd, cols),
            );
        }
    }
    set_u32(&mut ld, 44, epoch);
    set_u32(&mut ld, 48, p);
    set_u32(&mut ld, 52, start as u32);
    set_u32(&mut ld, 56, (end - start) as u32);
    set_u32(&mut ld, 60, part_end as u32);
    Ok(())
}

fn merge(pid: &Pubkey, a: &[AccountInfo], data: &[u8]) -> ProgramResult {
    check(a.len() >= 4 && data.len() == 4)?;
    state(pid, &a[0], &a[1])?;
    let mut sd = a[0].try_borrow_mut_data()?;
    model(pid, &a[2], &sd)?;
    let epoch = u32_at(&sd, 120);
    check(u32_at(data, 0) == epoch)?;
    let p = u32_at(&sd, 104);
    let start = u32_at(&sd, 116) as usize;
    let count = (total(&sd).saturating_sub(start))
        .div_ceil(stride(&sd))
        .min(LANES);
    check(count > 0 && a.len() == 3 + count)?;
    let mut cursor = start;
    for index in 0..count {
        owned(pid, &a[3 + index], LANE_SIZE)?;
        let ld = a[3 + index].try_borrow_data()?;
        check(
            &ld[..8] == b"SEALANE2"
                && &ld[8..40] == a[0].key.as_ref()
                && u32_at(&ld, 40) == index as u32
                && u32_at(&ld, 44) == epoch
                && u32_at(&ld, 48) == p
                && u32_at(&ld, 52) == cursor as u32,
        )?;
        let n = stride(&sd).min(total(&sd) - cursor);
        check(u32_at(&ld, 56) == n as u32 && u32_at(&ld, 60) == n as u32)?;
        if p == 5 {
            let chunks = (u32_at(&sd, 112) as usize + 1).div_ceil(ATTN_CHUNK);
            let head = cursor / chunks;
            let old_max = f(&sd, ATTN_META + head * 2);
            let old_sum = f(&sd, ATTN_META + head * 2 + 1);
            let max = old_max.max(f32_at(&ld, 128 + HEAD_DIM * 4));
            let a_scale = libm::expf(old_max - max);
            let b_scale = libm::expf(f32_at(&ld, 128 + HEAD_DIM * 4) - max);
            let sum = old_sum * a_scale + f32_at(&ld, 132 + HEAD_DIM * 4) * b_scale;
            for i in 0..HEAD_DIM {
                let value = f(&sd, ATTN + head * HEAD_DIM + i) * a_scale
                    + f32_at(&ld, 128 + i * 4) * b_scale;
                put(
                    &mut sd,
                    ATTN + head * HEAD_DIM + i,
                    if cursor % chunks + 1 == chunks {
                        value / sum
                    } else {
                        value
                    },
                );
            }
            put(&mut sd, ATTN_META + head * 2, max);
            put(&mut sd, ATTN_META + head * 2 + 1, sum);
        } else {
            for i in 0..n {
                let row = cursor + i;
                let value = f32_at(&ld, 128 + i * 4);
                if p == 13 {
                    if value > f32_at(&sd, 140) {
                        set_f32(&mut sd, 140, value);
                        set_u32(&mut sd, 128, row as u32);
                    }
                } else {
                    let offset = match p {
                        3 => Q + row,
                        6 | 10 => OUT + row,
                        8 => GATE + row,
                        9 => ACT + row,
                        _ => return Err(E::InvalidInstructionData),
                    };
                    put(&mut sd, offset, value);
                }
            }
        }
        cursor += n;
    }
    if cursor == total(&sd) {
        phase(
            &mut sd,
            match p {
                5 => 15,
                9 => 16,
                _ => p + 1,
            },
        );
    } else {
        set_u32(&mut sd, 116, cursor as u32);
        set_u32(&mut sd, 120, epoch + 1);
    }
    Ok(())
}

fn close(pid: &Pubkey, a: &[AccountInfo]) -> ProgramResult {
    check(a.len() >= 2)?;
    state(pid, &a[0], &a[1])?;
    for lane in &a[2..] {
        owned(pid, lane, LANE_SIZE)?;
        let d = lane.try_borrow_data()?;
        check(&d[..8] == b"SEALANE2" && &d[8..40] == a[0].key.as_ref())?;
    }
    for target in std::iter::once(&a[0]).chain(a[2..].iter()) {
        let balance = target.lamports();
        let refund = a[1]
            .lamports()
            .checked_add(balance)
            .ok_or(E::ArithmeticOverflow)?;
        **target.try_borrow_mut_lamports()? = 0;
        **a[1].try_borrow_mut_lamports()? = refund;
        target.try_borrow_mut_data()?.fill(0);
    }
    Ok(())
}

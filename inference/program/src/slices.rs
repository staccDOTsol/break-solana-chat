use super::*;

// A slice account has the same value offsets as a lane, but owns only one
// fixed slice index. Matrix transactions share no writable output accounts.
pub(super) fn init(pid: &Pubkey, a: &[AccountInfo], data: &[u8]) -> ProgramResult {
    check(a.len() == 3 && data.len() == 2 && (data[0] as usize) < LANES && data[1] < 16)?;
    owned(pid, &a[0], LANE_SIZE)?;
    signed(&a[0])?;
    state(pid, &a[1], &a[2])?;
    let mut d = a[0].try_borrow_mut_data()?;
    check(d[..8] == [0; 8])?;
    d[..8].copy_from_slice(b"SEASLCE3");
    d[8..40].copy_from_slice(a[1].key.as_ref());
    set_u32(&mut d, 40, data[0] as u32);
    set_u32(&mut d, 44, u32::MAX);
    set_u32(&mut d, 68, data[1] as u32);
    Ok(())
}

pub(super) fn merge(pid: &Pubkey, a: &[AccountInfo], data: &[u8]) -> ProgramResult {
    check(a.len() >= 5 && data.len() == 4)?;
    state(pid, &a[0], &a[2])?;
    owned(pid, &a[1], LANE_SIZE)?;
    let sd = a[0].try_borrow_data()?;
    model(pid, &a[3], &sd)?;
    let epoch = u32_at(&sd, 120);
    check(u32_at(data, 0) == epoch)?;
    let p = u32_at(&sd, 104);
    check(matches!(p, 3 | 6 | 8 | 10 | 13))?;
    let mut lane = a[1].try_borrow_mut_data()?;
    check(&lane[..8] == b"SEALANE2" && &lane[8..40] == a[0].key.as_ref())?;
    let index = u32_at(&lane, 40) as usize;
    check(index < LANES)?;
    let start = u32_at(&sd, 116) as usize + index * 128;
    check(start < total(&sd))?;
    let n = 128.min(total(&sd) - start);
    let chunk = if p == 10 { 8 } else { 24 };
    let count = n.div_ceil(chunk);
    check(a.len() == 4 + count)?;
    for part in 0..count {
        let account = &a[4 + part];
        owned(pid, account, LANE_SIZE)?;
        let slice = account.try_borrow_data()?;
        check(&slice[..8] == b"SEASLCE3" && &slice[8..40] == a[0].key.as_ref()
            && u32_at(&slice, 40) as usize == index && u32_at(&slice, 68) as usize == part
            && u32_at(&slice, 44) == epoch && u32_at(&slice, 48) == p
            && u32_at(&slice, 52) as usize == start && u32_at(&slice, 56) as usize == n
            && u32_at(&slice, 64) == 1u32 << part)?;
        let from = 128 + part * chunk * 4;
        let to = 128 + ((part + 1) * chunk).min(n) * 4;
        lane[from..to].copy_from_slice(&slice[from..to]);
    }
    set_u32(&mut lane, 44, epoch);
    set_u32(&mut lane, 48, p);
    set_u32(&mut lane, 52, start as u32);
    set_u32(&mut lane, 56, n as u32);
    set_u32(&mut lane, 60, n as u32);
    set_u32(&mut lane, 64, (1u32 << count) - 1);
    Ok(())
}

// Reclaim slices in bounded batches without closing the shared session yet.
pub(super) fn close(pid: &Pubkey, a: &[AccountInfo]) -> ProgramResult {
    check(a.len() >= 3)?;
    state(pid, &a[0], &a[1])?;
    for account in &a[2..] {
        owned(pid, account, LANE_SIZE)?;
        let d = account.try_borrow_data()?;
        check(&d[..8] == b"SEASLCE3" && &d[8..40] == a[0].key.as_ref())?;
    }
    for account in &a[2..] {
        let balance = a[1].lamports().checked_add(account.lamports()).ok_or(E::ArithmeticOverflow)?;
        **account.try_borrow_mut_lamports()? = 0;
        **a[1].try_borrow_mut_lamports()? = balance;
        account.try_borrow_mut_data()?.fill(0);
    }
    Ok(())
}

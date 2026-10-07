//! Executes the production instruction handlers on the CPU for numerical tests.
//! This is NOT a transport fallback. The chat service cannot call this binary.
use sea_chat_inference::{layout::*, process_instruction};
use serde_json::Value;
use solana_program::{account_info::AccountInfo, pubkey::Pubkey};
use std::{fs::File, io::Write, path::PathBuf};
fn key(i: u32) -> Pubkey {
    let mut a = [42; 32];
    a[..4].copy_from_slice(&i.to_le_bytes());
    Pubkey::new_from_array(a)
}
fn info(i: u32, data: &'static mut [u8], pid: &'static Pubkey) -> AccountInfo<'static> {
    AccountInfo::new(
        Box::leak(Box::new(key(i))),
        true,
        true,
        Box::leak(Box::new(100_000_000_000)),
        data,
        pid,
        false,
        0,
    )
}
fn main() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let artifacts = root.join("artifacts/qwen3-8b-q4g128");
    let output = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "/tmp/qwen-native".into());
    std::fs::create_dir_all(&output).unwrap();
    let tokens: Vec<u32> = std::env::var("TOKENS")
        .unwrap_or_else(|_| "9707".into())
        .split(',')
        .map(|x| x.parse().unwrap())
        .collect();
    let manifest: Value =
        serde_json::from_slice(&std::fs::read(artifacts.join("manifest.json")).unwrap()).unwrap();
    let files = manifest["files"].as_array().unwrap();
    let pid = Box::leak(Box::new(key(999)));
    let mut registry = vec![0; 128 + files.len() * 64];
    registry[..8].copy_from_slice(b"SEABLOB2");
    registry[8] = 1;
    registry[9] = 1;
    set_u32(&mut registry, 48, files.len() as u32);
    let blobs: Vec<_> = files
        .iter()
        .enumerate()
        .map(|(i, f)| {
            let desc = &mut registry[128 + i * 64..128 + (i + 1) * 64];
            desc[..32].copy_from_slice(key(2000 + i as u32).as_ref());
            for (j, name) in ["tensor", "rowStart", "rows", "cols", "encoding", "size"]
                .iter()
                .enumerate()
            {
                set_u32(desc, 32 + j * 4, f[name].as_u64().unwrap() as u32);
            }
            let file = File::open(artifacts.join(f["name"].as_str().unwrap())).unwrap();
            // Export artifacts are immutable during validation. Private COW mappings
            // modify only the seal byte, leaving the exported payload untouched.
            let map = Box::leak(Box::new(unsafe {
                memmap2::MmapOptions::new().map_copy(&file).unwrap()
            }));
            map[8] = 1;
            info(2000 + i as u32, &mut map[..], pid)
        })
        .collect();
    let state = info(1, Box::leak(vec![0; STATE_SIZE].into_boxed_slice()), pid);
    let auth = info(2, Box::leak(vec![].into_boxed_slice()), pid);
    let registry = info(3, Box::leak(registry.into_boxed_slice()), pid);
    process_instruction(pid, &[state.clone(), auth.clone(), registry.clone()], &[0]).unwrap();
    let lanes: Vec<_> = (0..LANES)
        .map(|i| {
            let lane = info(
                10 + i as u32,
                Box::leak(vec![0; LANE_SIZE].into_boxed_slice()),
                pid,
            );
            process_instruction(
                pid,
                &[lane.clone(), state.clone(), auth.clone()],
                &[1, i as u8],
            )
            .unwrap();
            lane
        })
        .collect();
    let find = |tensor: usize, row: usize| {
        files
            .iter()
            .position(|f| {
                f["tensor"].as_u64() == Some(tensor as u64)
                    && f["rowStart"].as_u64().unwrap() as usize <= row
                    && row
                        < (f["rowStart"].as_u64().unwrap() + f["rows"].as_u64().unwrap()) as usize
            })
            .unwrap()
    };
    let mut calls = 0usize;
    for (pos, token) in tokens.iter().enumerate() {
        let epoch = u32_at(&state.try_borrow_data().unwrap(), 120);
        let mut start = vec![2];
        start.extend(token.to_le_bytes());
        start.push(1);
        start.extend(epoch.to_le_bytes());
        process_instruction(pid, &[state.clone(), auth.clone()], &start).unwrap();
        loop {
            let sd = state.try_borrow_data().unwrap();
            let phase = u32_at(&sd, 104);
            let layer = u32_at(&sd, 108) as usize;
            let cursor = u32_at(&sd, 116) as usize;
            let epoch = u32_at(&sd, 120);
            if std::env::var_os("CAPTURE_DEBUG").is_some()
                && pos == 1
                && layer == 0
                && cursor == 0
                && [5, 7, 8, 9, 11].contains(&phase)
            {
                std::fs::write(format!("{output}/state-{phase}.bin"), &sd[..]).unwrap();
            }
            if phase == 14 {
                println!(
                    "position={pos} input={token} prediction={} calls={calls}",
                    u32_at(&sd, 128)
                );
                let final_hidden: Vec<u8> = (0..DIM)
                    .flat_map(|i| f(&sd, OUT + i).to_le_bytes())
                    .collect();
                std::fs::write(format!("{output}/final-{pos}.f32"), final_hidden).unwrap();
                break;
            }
            drop(sd);
            let parallel = [3, 5, 6, 8, 9, 10, 13].contains(&phase);
            if !parallel {
                let tensor = match phase {
                    1 => Some((0, *token as usize)),
                    2 | 4 | 7 => Some((3 + layer * 8, 0)),
                    12 => Some((1, 0)),
                    _ => None,
                };
                let desc = tensor.map(|(t, r)| find(t, r));
                let mut a = vec![state.clone(), auth.clone(), registry.clone()];
                if let Some(i) = desc {
                    a.push(blobs[i].clone());
                }
                let mut data = vec![3];
                data.extend(epoch.to_le_bytes());
                data.extend((desc.unwrap_or(0) as u16).to_le_bytes());
                process_instruction(pid, &a, &data).unwrap();
                calls += 1;
                if phase == 11 {
                    let d = state.try_borrow_data().unwrap();
                    let hidden: Vec<u8> =
                        (0..DIM).flat_map(|i| f(&d, H + i).to_le_bytes()).collect();
                    std::fs::write(format!("{output}/hidden-{pos}-{layer}.f32"), hidden).unwrap();
                    println!("position={pos} layer={layer} calls={calls}");
                }
                continue;
            }
            let total = match phase {
                3 => DIM + KV_DIM * 2,
                5 => HEADS * (pos + 1).div_ceil(ATTN_CHUNK),
                6 | 10 => DIM,
                8 => FFN * 2,
                9 => FFN,
                13 => VOCAB,
                _ => unreachable!(),
            };
            let stride = match phase {
                5 => 1,
                _ => 128,
            };
            let count = (total - cursor).div_ceil(stride).min(LANES);
            let mut logits = if phase == 13 {
                Some(
                    std::fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(format!("{output}/logits-{pos}.f32"))
                        .unwrap(),
                )
            } else {
                None
            };
            for i in 0..count {
                let row = cursor + i * stride;
                let tensor = match phase {
                    3 if row < DIM => Some((4 + layer * 8, row)),
                    3 if row < DIM + KV_DIM => Some((5 + layer * 8, row - DIM)),
                    3 => Some((6 + layer * 8, row - DIM - KV_DIM)),
                    6 => Some((7 + layer * 8, row)),
                    8 if row < FFN => Some((8 + layer * 8, row)),
                    8 => Some((9 + layer * 8, row - FFN)),
                    10 => Some((10 + layer * 8, row)),
                    13 => Some((2, row)),
                    _ => None,
                };
                let desc = tensor.map(|(t, r)| find(t, r));
                let mut a = vec![
                    state.clone(),
                    lanes[i].clone(),
                    auth.clone(),
                    registry.clone(),
                ];
                if let Some(j) = desc {
                    a.push(blobs[j].clone());
                }
                let chunk = match phase {
                    5 => 1,
                    9 => 128,
                    10 => 8,
                    _ => 24,
                };
                for part in (0..(total - row).min(stride)).step_by(chunk) {
                    let mut data = vec![4];
                    data.extend(epoch.to_le_bytes());
                    data.extend((desc.unwrap_or(0) as u16).to_le_bytes());
                    data.extend((part as u16).to_le_bytes());
                    process_instruction(pid, &a, &data).unwrap();
                    calls += 1;
                }
                if let Some(file) = &mut logits {
                    file.write_all(
                        &lanes[i].try_borrow_data().unwrap()
                            [128..128 + (total - row).min(stride) * 4],
                    )
                    .unwrap();
                }
            }
            let mut a = vec![state.clone(), auth.clone(), registry.clone()];
            a.extend(lanes[..count].iter().cloned());
            let mut data = vec![5];
            data.extend(epoch.to_le_bytes());
            process_instruction(pid, &a, &data).unwrap();
            calls += 1;
        }
    }
}

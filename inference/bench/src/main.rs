use mollusk_svm::Mollusk;
use serde_json::Value;
use solana_account::Account;
use solana_instruction::{AccountMeta, Instruction};
use solana_pubkey::Pubkey;
#[allow(dead_code)]
#[path = "../../program/src/layout.rs"]
mod layout;
use layout::*;
#[allow(dead_code)]
#[path = "../../program/src/math.rs"]
mod oracle;

fn key(i: u32) -> Pubkey {
    let mut a = [42; 32];
    a[..4].copy_from_slice(&i.to_le_bytes());
    Pubkey::new_from_array(a)
}
fn main() {
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let artifacts = root.join("artifacts/qwen3-8b-q4g128");
    let manifest: Value =
        serde_json::from_slice(&std::fs::read(artifacts.join("manifest.json")).unwrap()).unwrap();
    let files = manifest["files"].as_array().unwrap();
    let pid = key(999);
    let mut reg = Account::new(1_000_000_000, 128 + files.len() * 64, &pid);
    reg.data[..8].copy_from_slice(b"SEABLOB2");
    reg.data[8] = 1;
    reg.data[9] = 1;
    set_u32(&mut reg.data, 48, files.len() as u32);
    for (i, file) in files.iter().enumerate() {
        let d = &mut reg.data[128 + i * 64..128 + (i + 1) * 64];
        d[..32].copy_from_slice(key(2000 + i as u32).as_ref());
        for (j, name) in ["tensor", "rowStart", "rows", "cols", "encoding", "size"]
            .iter()
            .enumerate()
        {
            set_u32(d, 32 + j * 4, file[name].as_u64().unwrap() as u32);
        }
    }
    let mut svm = Mollusk::default();
    svm.feature_set.remaining_compute_units_syscall_enabled = false;
    svm.feature_set.increase_tx_account_lock_limit = false;
    svm.feature_set.raise_cpi_nesting_limit_to_8 = false;
    svm.feature_set.disable_sbpf_v0_execution = false;
    svm.feature_set.disable_sbpf_v0_v1_v2_deployment = false;
    svm.compute_budget.compute_unit_limit = std::env::var("BENCH_CU")
        .ok()
        .map(|x| x.parse().unwrap())
        .unwrap_or(1_400_000);
    svm.program_cache =
        mollusk_svm::program::ProgramCache::new(&svm.feature_set, &svm.compute_budget, false);
    svm.add_program_with_loader_and_elf(
        &pid,
        &mollusk_svm::program::loader_keys::LOADER_V3,
        &std::fs::read(root.join("program/target/deploy/sea_chat_inference.so")).unwrap(),
    );
    let mut failures = 0;
    for (phase, tensor) in [
        (1, 0),
        (2, 3),
        (3, 4),
        (4, 3),
        (5, 0),
        (6, 7),
        (7, 3),
        (8, 8),
        (9, 0),
        (10, 10),
        (11, 0),
        (12, 1),
        (13, 2),
        (15, 0),
        (16, 0),
    ] {
        let parallel = [3, 5, 6, 8, 9, 10, 13].contains(&phase);
        let mut state = Account::new(100_000_000_000, STATE_SIZE, &pid);
        state.data[..8].copy_from_slice(b"SEACHAT2");
        state.data[8..40].copy_from_slice(key(2).as_ref());
        state.data[40..72].copy_from_slice(key(3).as_ref());
        set_u32(&mut state.data, 104, phase);
        set_u32(&mut state.data, 112, 127);
        set_u32(&mut state.data, 120, 1);
        for i in 0..(ATTN_META + HEADS * 2) {
            put(&mut state.data, i, ((i * 7 % 113) as f32 - 56.0) * 0.002);
        }
        for i in 0..FFN {
            state.data[QUANT + i] = (i % 251) as u8;
        }
        for i in 0..FFN / GROUP {
            set_f32(&mut state.data, SCALES + i * 4, 0.001);
        }
        for head in 0..HEADS {
            set_f32(&mut state.data, QUERY_SCALES + head * 4, 0.002);
            for j in 0..HEAD_DIM {
                state.data[QUERY + head * HEAD_DIM + j] = (j % 127) as u8;
            }
        }
        for pos in 0..MAX_SEQ {
            for head in 0..KV_HEADS {
                for v in [false, true] {
                    let offset = cache(0, pos, head, v);
                    set_f32(&mut state.data, offset, 0.002);
                    for j in 0..HEAD_DIM {
                        state.data[offset + 4 + j] = (j % 127) as u8;
                    }
                }
            }
        }
        let mut lane = Account::new(100_000_000, LANE_SIZE, &pid);
        lane.data[..8].copy_from_slice(b"SEALANE2");
        lane.data[8..40].copy_from_slice(key(1).as_ref());
        let mut accounts = vec![
            (key(1), state),
            (key(2), Account::new(1_000_000, 0, &Pubkey::default())),
            (key(3), reg.clone()),
            (key(10), lane),
        ];
        let r = |i| AccountMeta::new_readonly(key(i), false);
        let w = |i| AccountMeta::new(key(i), false);
        let auth = AccountMeta::new_readonly(key(2), true);
        let mut metas = if parallel {
            vec![r(1), w(10), auth, r(3)]
        } else {
            vec![w(1), auth, r(3)]
        };
        let mut data = vec![if parallel { 4 } else { 3 }];
        data.extend(1u32.to_le_bytes());
        let desc = files
            .iter()
            .position(|f| f["tensor"].as_u64() == Some(tensor) && f["rowStart"].as_u64() == Some(0))
            .unwrap();
        data.extend((desc as u16).to_le_bytes());
        if parallel {
            data.extend(0u16.to_le_bytes());
        }
        if ![5, 9, 11, 15, 16].contains(&phase) {
            let mut weight = Account::new(100_000_000_000, 0, &pid);
            weight.data =
                std::fs::read(artifacts.join(files[desc]["name"].as_str().unwrap())).unwrap();
            weight.data[8] = 1;
            accounts.push((key(2000 + desc as u32), weight));
            metas.push(r(2000 + desc as u32));
        }
        let ix = Instruction::new_with_bytes(pid, &data, metas);
        let mut current = accounts.clone();
        let mut work = ix.clone();
        let mut calls = 0;
        loop {
            let before = &current.iter().find(|a| a.0 == key(1)).unwrap().1.data;
            let mut expected = before.clone();
            let stage = u32_at(before, 116) as usize;
            let weights = current
                .iter()
                .find(|a| a.0 == key(2000 + desc as u32))
                .map(|a| &a.1.data[..]);
            match phase {
                1 => oracle::embed(&mut expected, &weights.unwrap()[128..128 + row_bytes(DIM)]),
                2 | 7 | 12 => {
                    if stage == 0 {
                        if phase == 7 {
                            for i in 0..DIM {
                                let value = f(&expected, H + i) + f(&expected, OUT + i);
                                put(&mut expected, H + i, value);
                            }
                        }
                        oracle::norm_prepare(&mut expected);
                    } else {
                        oracle::norm_part(
                            &mut expected,
                            weights.unwrap(),
                            128 + if phase == 7 { DIM * 4 } else { 0 },
                            (stage - 1) * 1024,
                        );
                    }
                }
                4 => {
                    if stage == 0 {
                        oracle::rope_prepare(&mut expected, 127);
                    } else {
                        oracle::rope_part(&mut expected, weights.unwrap(), 0, 127, (stage - 1) * 8);
                    }
                    if stage == 6 {
                        for i in 0..DIM {
                            put(&mut expected, ATTN + i, 0.0);
                        }
                        for head in 0..HEADS {
                            put(&mut expected, ATTN_META + head * 2, f32::NEG_INFINITY);
                            put(&mut expected, ATTN_META + head * 2 + 1, 0.0);
                        }
                    }
                }
                11 => {
                    for i in 0..DIM {
                        let value = f(&expected, H + i) + f(&expected, OUT + i);
                        put(&mut expected, H + i, value);
                    }
                }
                15 | 16 => oracle::quantize(
                    &mut expected,
                    if phase == 15 { ATTN } else { ACT },
                    stage,
                    1024,
                ),
                _ => (),
            }
            let result = svm.process_instruction(&work, &current);
            println!(
                "phase={phase} step={calls} cu={} result={:?}",
                result.compute_units_consumed, result.program_result
            );
            if result.program_result.is_err() {
                failures += 1;
                break;
            }
            if parallel {
                let mut expected_lane = current
                    .iter()
                    .find(|a| a.0 == key(10))
                    .unwrap()
                    .1
                    .data
                    .clone();
                match phase {
                    5 => oracle::attention(before, &mut expected_lane, 0, 0, 127),
                    9 => {
                        for row in 0..128 {
                            let gate = f(before, GATE + row);
                            set_f32(
                                &mut expected_lane,
                                128 + row * 4,
                                gate / (1.0 + libm::expf(-gate)) * f(before, UP + row),
                            );
                        }
                    }
                    _ => {
                        let cols = if phase == 10 { FFN } else { DIM };
                        let chunk = if phase == 10 { 8 } else { 24 };
                        let weight = weights.unwrap();
                        for row in 0..chunk {
                            let offset = 128 + row * row_bytes(cols);
                            set_f32(
                                &mut expected_lane,
                                128 + row * 4,
                                oracle::matrow(
                                    &weight[offset..offset + row_bytes(cols)],
                                    before,
                                    cols,
                                ),
                            );
                        }
                    }
                }
                let actual = &result
                    .resulting_accounts
                    .iter()
                    .find(|a| a.0 == key(10))
                    .unwrap()
                    .1
                    .data;
                assert!(
                    actual[128..] == expected_lane[128..],
                    "native/SBF tile arithmetic differs at phase={phase}"
                );
            }
            if !parallel {
                let actual = &result
                    .resulting_accounts
                    .iter()
                    .find(|a| a.0 == key(1))
                    .unwrap()
                    .1
                    .data;
                let mismatches = actual[FLOATS..]
                    .iter()
                    .zip(expected[FLOATS..].iter())
                    .filter(|(a, b)| a != b)
                    .count();
                assert_eq!(
                    mismatches, 0,
                    "native/SBF arithmetic differs at phase={phase}, stage={stage}"
                );
            }
            calls += 1;
            if parallel || phase == 1 || phase == 11 {
                break;
            }
            current = result.resulting_accounts;
            let state = &current.iter().find(|a| a.0 == key(1)).unwrap().1.data;
            if u32_at(state, 104) != phase {
                break;
            }
            work.data[1..5].copy_from_slice(&u32_at(state, 120).to_le_bytes());
            assert!(calls < 20);
        }
        if parallel {
            for pos in if phase == 5 {
                vec![0u32, 127]
            } else {
                vec![127]
            } {
                let mut wave = accounts.clone();
                set_u32(&mut wave[0].1.data, 112, pos);
                for i in 1..LANES {
                    let mut lane = wave[3].1.clone();
                    set_u32(&mut lane.data, 40, i as u32);
                    wave.push((key(10 + i as u32), lane));
                }
                for i in 0..LANES {
                    let mut tile = ix.clone();
                    tile.accounts[1].pubkey = key(10 + i as u32);
                    let stride = if phase == 5 { 1 } else { 128 };
                    let chunk = match phase {
                        5 => 1,
                        9 => 128,
                        10 => 8,
                        _ => 24,
                    };
                    if ![5, 9].contains(&phase) {
                        let row = i * stride;
                        let desc = files
                            .iter()
                            .position(|f| {
                                f["tensor"].as_u64() == Some(tensor)
                                    && f["rowStart"].as_u64().unwrap() as usize <= row
                                    && row
                                        < (f["rowStart"].as_u64().unwrap()
                                            + f["rows"].as_u64().unwrap())
                                            as usize
                            })
                            .unwrap();
                        let blob_key = key(2000 + desc as u32);
                        if !wave.iter().any(|a| a.0 == blob_key) {
                            let mut weight = Account::new(100_000_000_000, 0, &pid);
                            weight.data = std::fs::read(
                                artifacts.join(files[desc]["name"].as_str().unwrap()),
                            )
                            .unwrap();
                            weight.data[8] = 1;
                            wave.push((blob_key, weight));
                        }
                        tile.accounts[4].pubkey = blob_key;
                        tile.data[5..7].copy_from_slice(&(desc as u16).to_le_bytes());
                    }
                    for part in (0..stride).step_by(chunk) {
                        tile.data[7..9].copy_from_slice(&(part as u16).to_le_bytes());
                        let result = svm.process_instruction(&tile, &wave);
                        assert!(
                            result.program_result.is_ok(),
                            "tile {phase}/{i}/{part}: {:?}",
                            result.program_result
                        );
                        wave = result.resulting_accounts;
                        if part == 0 {
                            let retry = svm.process_instruction(&tile, &wave);
                            assert!(retry.program_result.is_ok());
                            assert_eq!(
                                retry.resulting_accounts, wave,
                                "duplicate slice changed state"
                            );
                        }
                    }
                }
                let mut metas = vec![
                    AccountMeta::new(key(1), false),
                    AccountMeta::new_readonly(key(2), true),
                    AccountMeta::new_readonly(key(3), false),
                ];
                metas.extend(
                    (0..LANES).map(|i| AccountMeta::new_readonly(key(10 + i as u32), false)),
                );
                let merge = Instruction::new_with_bytes(pid, &[5, 1, 0, 0, 0], metas);
                let result = svm.process_instruction(&merge, &wave);
                println!(
                    "phase={phase} merge pos={pos} cu={} result={:?}",
                    result.compute_units_consumed, result.program_result
                );
                if result.program_result.is_err() {
                    failures += 1;
                }
                // Identically numbered workers belonging to another signer/session
                // cannot contribute to this state, even with a current epoch.
                let lane = wave.iter_mut().find(|a| a.0 == key(10)).unwrap();
                lane.1.data[8] ^= 1;
                assert!(
                    svm.process_instruction(&merge, &wave)
                        .program_result
                        .is_err(),
                    "foreign session lane accepted"
                );
            }
        }
        // Authority, stale work and model substitution must be rejected in SBF.
        let mut bad = ix.clone();
        let auth_index = if parallel { 2 } else { 1 };
        bad.accounts[auth_index].is_signer = false;
        assert!(
            svm.process_instruction(&bad, &accounts)
                .program_result
                .is_err(),
            "unsigned authority accepted"
        );
        if parallel && ![5, 9].contains(&phase) {
            let mut skipped = ix.clone();
            skipped.data[7..9]
                .copy_from_slice(&(if phase == 10 { 8u16 } else { 24u16 }).to_le_bytes());
            assert!(
                svm.process_instruction(&skipped, &accounts)
                    .program_result
                    .is_err(),
                "out-of-order slice accepted"
            );
        }
        let mut stale = ix.clone();
        stale.data[1..5].copy_from_slice(&0u32.to_le_bytes());
        assert!(
            svm.process_instruction(&stale, &accounts)
                .program_result
                .is_err(),
            "stale epoch accepted"
        );
    }
    assert_eq!(
        failures, 0,
        "instructions exceed the real transaction compute limit"
    );
    println!("session_bytes={STATE_SIZE} all phases fit; unsigned/stale writes rejected");
}

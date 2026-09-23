//! Local stdin/stdout bridge for already-signed wire transactions. No payer keys.
use base64::{engine::general_purpose::STANDARD, Engine};
use solana_client::nonblocking::{rpc_client::RpcClient, tpu_client::TpuClient};
use solana_tpu_client::tpu_client::TpuClientConfig;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let rpc_url = std::env::var("SOLANA_TESTNET_RPC")
        .unwrap_or_else(|_| "https://api.testnet.solana.com".into());
    let ws_url = std::env::var("SOLANA_TESTNET_WS").unwrap_or_else(|_| {
        rpc_url
            .replacen("https://", "wss://", 1)
            .replacen("http://", "ws://", 1)
    });
    let rpc = Arc::new(RpcClient::new(rpc_url));
    if rpc.get_genesis_hash().await?.to_string() != "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY" {
        return Err("relay is restricted to testnet".into());
    }
    let client = Arc::new(
        TpuClient::new(
            "sea-inference",
            rpc,
            &ws_url,
            TpuClientConfig { fanout_slots: 12 },
        )
        .await?,
    );
    let mut output = tokio::io::stdout();
    output.write_all(b"{\"ready\":true}\n").await?;
    output.flush().await?;
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut sends = tokio::task::JoinSet::new();
    let mut next_send = tokio::time::Instant::now();
    while let Some(line) = lines.next_line().await? {
        if line.len() > 1_600_000 {
            return Err("relay batch too large".into());
        }
        let value: serde_json::Value = serde_json::from_str(&line)?;
        let id = value["id"].clone();
        let encoded = value["wires"].as_array().ok_or("missing wires")?;
        if encoded.is_empty() || encoded.len() > 256 {
            return Err("invalid batch size".into());
        }
        let mut wires = Vec::with_capacity(encoded.len());
        for encoded in encoded {
            let wire = STANDARD.decode(encoded.as_str().ok_or("wire must be base64")?)?;
            if wire.len() < 65 || wire.len() > 4096 {
                return Err("invalid wire length".into());
            }
            wires.push(wire);
        }
        // One slow leader must not serialize every independent batch. Bound
        // outstanding deliveries; confirmation still happens through RPC.
        // Stay below Agave's observed 200-stream/s unstaked-peer quota even
        // when many independently signed lanes submit at once.
        tokio::time::sleep_until(next_send).await;
        next_send = tokio::time::Instant::now()
            + std::time::Duration::from_secs_f64(wires.len() as f64 / 150.0);
        while sends.try_join_next().is_some() {}
        if sends.len() >= 8 {
            sends.join_next().await;
        }
        let sender = client.clone();
        sends.spawn(async move {
            match tokio::time::timeout(
                std::time::Duration::from_secs(3),
                sender.try_send_wire_transaction_batch(wires),
            )
            .await
            {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    eprintln!("TPU delivery failed; confirmation/retry required: {error}")
                }
                // Some leaders can remain unreachable after another leader
                // already accepted the batch. Let RPC decide what to retry.
                Err(_) => {}
            }
        });
        let response = serde_json::json!({"id":id,"queued":true});
        output.write_all(format!("{response}\n").as_bytes()).await?;
        output.flush().await?;
    }
    while sends.join_next().await.is_some() {}
    Ok(())
}

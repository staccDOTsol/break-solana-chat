#!/usr/bin/env python3
"""Read-only testnet audit of every currently sealed model payload (Python 3.14+).

Reads only the public half of local deployment keypair files. Never signs or sends
transactions. Full account reads are paced alongside the resumable uploader.
"""
import base64
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import time
import urllib.error
import urllib.request
from compression import zstd

ROOT = Path(__file__).resolve().parent
ARTIFACTS = ROOT / "artifacts/qwen3-8b-q4g128"
DEPLOYMENT = ROOT / "deployment"
RPC = "https://api.testnet.solana.com"
GENESIS = "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY"
ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
REPORT = ROOT / "reports/testnet-payload-audit.json"


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def pubkey(path):
    raw = json.loads(path.read_text())
    if not isinstance(raw, list) or len(raw) != 64:
        raise ValueError("Unexpected key file format")
    public = bytes(raw[32:])
    number, result = int.from_bytes(public, "big"), ""
    while number:
        number, digit = divmod(number, 58)
        result = ALPHABET[digit] + result
    return "1" * (len(public) - len(public.lstrip(b"\0"))) + result


def rpc(method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    for attempt in range(6):
        try:
            request = urllib.request.Request(RPC, data=body, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(request, timeout=30) as response:
                result = json.load(response)
            if "error" in result:
                if result["error"].get("code") == -32016 and attempt < 5:
                    time.sleep(2)
                    continue
                raise RuntimeError(result["error"])
            return result["result"]
        except urllib.error.HTTPError as error:
            if error.code not in (429, 502, 503, 504) or attempt == 5:
                raise
            time.sleep(min(30, 2 ** (attempt + 1)))
    raise RuntimeError("RPC retries exhausted")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reuse-report", type=Path, help="Reuse finalized byte comparisons of still-sealed accounts")
    parser.add_argument("--report", type=Path, default=REPORT)
    args = parser.parse_args()
    manifest = json.loads((ARTIFACTS / "manifest.json").read_text())
    identity = json.loads((DEPLOYMENT / "identity.json").read_text())
    if rpc("getGenesisHash", []) != GENESIS or identity["genesis"] != GENESIS:
        raise RuntimeError("Testnet identity mismatch")
    addresses = [pubkey(DEPLOYMENT / f"weight-{i}-keypair.json") for i in range(len(manifest["files"]))]
    deployed = json.loads((ROOT / "reports/testnet-program.json").read_text())
    if deployed["program"] != identity["program"] or not deployed["verifiedByteForByte"]:
        raise RuntimeError("Verified program identity mismatch")

    def program_version():
        result = rpc("getAccountInfo", [deployed["programData"], {"encoding": "base64", "commitment": "finalized"}])
        account = result["value"]
        if not account or account["owner"] != "BPFLoaderUpgradeab1e11111111111111111111111":
            raise RuntimeError("Program data missing or changed owner")
        data = base64.b64decode(account["data"][0])
        if data[:4] != b"\3\0\0\0" or hashlib.sha256(data[45:]).hexdigest() != deployed["sha256"]:
            raise RuntimeError("Live program differs from verified program")
        return int.from_bytes(data[4:12], "little")

    deployment_slot = program_version()
    previous = {}
    if args.reuse_report:
        old = json.loads(args.reuse_report.read_text())
        if not old.get("complete") or old.get("running") or any(old.get(k) != v for k, v in {
            "cluster": "testnet", "program": identity["program"], "revision": manifest["revision"], "model": manifest["model"]}.items()):
            raise RuntimeError("Cannot reuse an incomplete or unrelated audit")
        previous = {entry["address"]: entry for entry in old["accounts"]}
    report = {"startedAt": now(), "pid": os.getpid(), "cluster": "testnet", "program": identity["program"],
              "model": manifest["model"], "revision": manifest["revision"], "scope": "all sealed weight accounts present at discovery",
              "genesis": GENESIS, "programSha256": deployed["sha256"], "programDeploymentSlot": deployment_slot,
              "running": True, "complete": False, "accounts": [], "verifiedPayloadBytes": 0, "reusedAccounts": 0}

    def save():
        report["updatedAt"] = now()
        temporary = args.report.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(report, indent=2) + "\n")
        temporary.replace(args.report)

    try:
        pending = []
        for start in range(0, len(addresses), 100):
            result = rpc("getMultipleAccounts", [addresses[start:start + 100], {
                "encoding": "base64", "commitment": "finalized", "dataSlice": {"offset": 0, "length": 128}}])
            for offset, account in enumerate(result["value"]):
                if account is None:
                    continue
                header = base64.b64decode(account["data"][0])
                if account["owner"] != identity["program"]:
                    raise RuntimeError(f"Wrong owner for weight-{start + offset}")
                if header[:8] == b"SEABLOB2" and header[8:10] == b"\1\0":
                    index = start + offset
                    spec = manifest["files"][index]
                    old = previous.get(addresses[index])
                    image_header = (ARTIFACTS / spec["name"]).open("rb")
                    with image_header:
                        expected_header = image_header.read(128)
                    if (old and old.get("byteForByteMatch") is True and old.get("headerMatches") is True
                            and old.get("expectedSha256") == old.get("actualSha256") == spec["payloadSha256"]
                            and old.get("payloadBytes") == spec["size"] - 128
                            and old.get("name") == f"weight-{index}" and old.get("file") == spec["name"]
                            and deployment_slot <= old["slot"] <= result["context"]["slot"]
                            and account["space"] == spec["size"] and header[48:68] == expected_header[48:68]):
                        report["accounts"].append({**old, "sealRecheckedAtSlot": result["context"]["slot"]})
                        report["verifiedPayloadBytes"] += old["payloadBytes"]
                        report["reusedAccounts"] += 1
                    else:
                        pending.append((index, result["context"]["slot"]))
            time.sleep(0.6)
        report["sealedAccountsAtDiscovery"] = len(pending) + report["reusedAccounts"]
        save()
        print(json.dumps({"auditStarted": len(pending), "reusedAccounts": report["reusedAccounts"], "report": str(args.report)}), flush=True)
        next_read = 0.0
        for index, minimum_slot in pending:
            time.sleep(max(0, next_read - time.monotonic()))
            next_read = time.monotonic() + 6
            spec = manifest["files"][index]
            image = (ARTIFACTS / spec["name"]).read_bytes()
            expected_hash = hashlib.sha256(image[128:]).hexdigest()
            if len(image) != spec["size"] or expected_hash != spec["payloadSha256"]:
                raise RuntimeError(f"Local manifest mismatch for weight-{index}")
            result = rpc("getAccountInfo", [addresses[index], {
                "encoding": "base64+zstd", "commitment": "finalized", "minContextSlot": minimum_slot}])
            account = result["value"]
            if account is None or account["owner"] != identity["program"]:
                raise RuntimeError(f"Missing account or changed owner for weight-{index}")
            actual = zstd.decompress(base64.b64decode(account["data"][0]))
            payload_hash = hashlib.sha256(actual[128:]).hexdigest()
            entry = {"name": f"weight-{index}", "address": addresses[index], "file": spec["name"],
                     "slot": result["context"]["slot"], "payloadBytes": len(actual) - 128,
                     "expectedSha256": expected_hash, "actualSha256": payload_hash,
                     "byteForByteMatch": actual[128:] == image[128:],
                     "headerMatches": len(actual) == len(image) and actual[:8] == b"SEABLOB2"
                     and actual[8:10] == b"\1\0" and actual[48:68] == image[48:68]}
            report["accounts"].append(entry)
            if not entry["byteForByteMatch"] or not entry["headerMatches"]:
                entry["mismatchingChunks"] = [
                    {"offset": pos, "end": min(pos + 3760, len(image)),
                     "allZeroOnChain": not any(actual[pos:pos + 3760])}
                    for pos in range(128, len(image), 3760)
                    if actual[pos:pos + 3760] != image[pos:pos + 3760]
                ][:32]
                raise RuntimeError(f"Payload/header mismatch in sealed weight-{index}")
            report["verifiedPayloadBytes"] += len(actual) - 128
            save()
            if len(report["accounts"]) % 10 == 0:
                print(json.dumps({"verifiedAccounts": len(report["accounts"]), "total": report["sealedAccountsAtDiscovery"],
                                  "verifiedPayloadBytes": report["verifiedPayloadBytes"]}), flush=True)
        if program_version() != deployment_slot:
            raise RuntimeError("Program changed during audit")
        report.update(complete=True, running=False, finishedAt=now())
        save()
        print(json.dumps({"auditComplete": True, "verifiedAccounts": len(pending),
                          "verifiedPayloadBytes": report["verifiedPayloadBytes"]}), flush=True)
    except BaseException as error:
        report.update(running=False, error=str(error))
        save()
        raise


if __name__ == "__main__":
    main()

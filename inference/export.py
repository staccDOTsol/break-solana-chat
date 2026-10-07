"""Export all Qwen3-8B weights into <=10 MiB Solana account images.

Q4G128: each group of 128 signed 4-bit weights has one binary16 scale.
No dropped layers, shortened vocabulary, or substituted checkpoint.
The manifest pins the upstream revision and every immutable payload hash.
"""
import argparse
import hashlib
import json
from pathlib import Path
import numpy as np
import torch
from huggingface_hub import snapshot_download
from safetensors import safe_open

MODEL = 'Qwen/Qwen3-8B'
REVISION = 'b968826d9c46dd6066d109eabc6255188de91218'
OUTPUT = Path(__file__).resolve().parent / 'artifacts' / 'qwen3-8b-q4g128'
HEADER, MAX_ACCOUNT, GROUP, ALIGN = 128, 10 * 1024**2, 128, 128
DIM, KV_DIM, FFN, LAYERS, VOCAB = 4096, 1024, 12288, 36, 151936


def quantize(tensor):
    x = tensor.float().reshape(tensor.shape[0], -1, GROUP)
    # Quantize the scale before the integers, so the decoder uses exactly the
    # scale used by the encoder. Tiny nonzero groups retain a representable scale.
    maximum = x.abs().amax(dim=-1)
    scale = torch.where(maximum > 0, (maximum / 7).clamp(min=2**-24), 1).half().float()
    q = torch.round(x / scale[..., None]).clamp(-7, 7).to(torch.int8).numpy()
    packed = ((q[..., 0::2] & 15) | ((q[..., 1::2] & 15) << 4)).astype(np.uint8)
    result = np.empty((*scale.shape, 66), dtype=np.uint8)
    result[..., :2] = scale.numpy().astype('<f2').view(np.uint8).reshape(*scale.shape, 2)
    result[..., 2:] = packed
    return result.reshape(tensor.shape[0], -1).tobytes()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, default=OUTPUT)
    args = parser.parse_args()
    torch.set_num_threads(6)
    checkpoint = Path(snapshot_download(MODEL, revision=REVISION, allow_patterns=['*.json', '*.safetensors', '*.txt']))
    config = json.loads((checkpoint / 'config.json').read_text())
    expected = {'hidden_size': DIM, 'intermediate_size': FFN, 'num_hidden_layers': LAYERS,
                'num_attention_heads': 32, 'num_key_value_heads': 8, 'head_dim': 128,
                'vocab_size': VOCAB, 'tie_word_embeddings': False}
    for name, value in expected.items():
        assert config[name] == value, (name, config[name], value)
    index = json.loads((checkpoint / 'model.safetensors.index.json').read_text())['weight_map']
    args.output.mkdir(parents=True, exist_ok=True)
    manifest = {'schema': 2, 'model': MODEL, 'revision': REVISION, 'format': 'q4g128-f16-v1',
                'groupSize': GROUP, 'config': config, 'files': [], 'tensorCount': 291,
                'maxSequenceLength': 128, 'lanes': 16}
    consumed = set()
    def tensor(name):
        consumed.add(name)
        with safe_open(checkpoint / index[name], framework='pt', device='cpu') as source:
            return source.get_tensor(name)
    def save(tid, start, rows, cols, encoding, body):
        name = f't{tid:03}-r{start:06}.bin'
        image = bytearray(HEADER) + body
        image[:8] = b'SEABLOB2'
        image[9] = 0  # immutable weight blob; uploader/seal filled on chain
        image[48:52] = tid.to_bytes(4, 'little')
        image[52:56] = start.to_bytes(4, 'little')
        image[56:60] = rows.to_bytes(4, 'little')
        image[60:64] = cols.to_bytes(4, 'little')
        image[64] = encoding  # 0=f32 vector, 1=Q4G128 matrix
        assert len(image) <= MAX_ACCOUNT
        (args.output / name).write_bytes(image)
        manifest['files'].append({'name': name, 'size': len(image), 'tensor': tid, 'rowStart': start,
            'rows': rows, 'cols': cols, 'encoding': encoding,
            'payloadSha256': hashlib.sha256(body).hexdigest()})
    def matrix(tid, name, rows, cols):
        value = tensor(name)
        assert tuple(value.shape) == (rows, cols)
        stride = cols // GROUP * 66
        shard_rows = (MAX_ACCOUNT - HEADER) // stride // ALIGN * ALIGN
        for start in range(0, rows, shard_rows):
            count = min(shard_rows, rows - start)
            save(tid, start, count, cols, 1, quantize(value[start:start + count]))
    matrix(0, 'model.embed_tokens.weight', VOCAB, DIM)
    save(1, 0, DIM, 1, 0, tensor('model.norm.weight').float().numpy().astype('<f4').tobytes())
    matrix(2, 'lm_head.weight', VOCAB, DIM)
    matrices = [('self_attn.q_proj.weight', DIM, DIM), ('self_attn.k_proj.weight', KV_DIM, DIM),
                ('self_attn.v_proj.weight', KV_DIM, DIM), ('self_attn.o_proj.weight', DIM, DIM),
                ('mlp.gate_proj.weight', FFN, DIM), ('mlp.up_proj.weight', FFN, DIM),
                ('mlp.down_proj.weight', DIM, FFN)]
    for layer in range(LAYERS):
        prefix = f'model.layers.{layer}.'
        # Qwen3 applies separate per-head Q/K RMSNorm before RoPE.
        norms = b''.join(tensor(prefix + key).float().numpy().astype('<f4').tobytes()
                        for key in ['input_layernorm.weight', 'post_attention_layernorm.weight',
                                    'self_attn.q_norm.weight', 'self_attn.k_norm.weight'])
        save(3 + layer * 8, 0, DIM * 2 + 256, 1, 0, norms)
        for kind, (key, rows, cols) in enumerate(matrices, 1):
            matrix(3 + layer * 8 + kind, prefix + key, rows, cols)
        print(f'Exported layer {layer + 1}/{LAYERS}', flush=True)
    assert consumed == set(index), f'Unexported weights: {set(index) - consumed}'
    manifest['accountBytes'] = sum(item['size'] for item in manifest['files'])
    manifest['registryBytes'] = HEADER + len(manifest['files']) * 64
    manifest['totalBytes'] = manifest['accountBytes'] + manifest['registryBytes']
    manifest['parameterCount'] = int(index and json.loads((checkpoint / 'model.safetensors.index.json').read_text())['metadata']['total_size']) // 2
    for name in ['tokenizer.json', 'tokenizer_config.json', 'config.json', 'generation_config.json']:
        source = checkpoint / name
        if source.exists(): (args.output / name).write_bytes(source.read_bytes())
    (args.output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps({k: manifest[k] for k in ['model', 'revision', 'accountBytes', 'registryBytes', 'totalBytes', 'parameterCount']}), flush=True)
    print(f'{len(manifest["files"])} accounts; {manifest["totalBytes"] / 1024**3:.4f} GiB', flush=True)


if __name__ == '__main__': main()

"""Independent NumPy reference for the exported Qwen3 model.

Compare every layer and the full vocabulary logits against the production Rust
handlers executed by the native validation harness. Never used to answer chat.
"""
import argparse
import ctypes
import sys
import json
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parent / 'artifacts/qwen3-8b-q4g128'
D, K, F, HEAD, LAYERS = 4096, 1024, 12288, 128, 36
# NumPy independently implements all inference/state operations, while these
# four scalar transcendental functions specify portable f32 rounding. Vector
# libm approximations can otherwise move activations across INT8 bin boundaries.
math_name = 'libsea_reference_math.dylib' if sys.platform == 'darwin' else 'libsea_reference_math.so'
libc = ctypes.CDLL(str(Path(__file__).resolve().parent / 'reference-math/target/release' / math_name))
for name in ['expf', 'sinf', 'cosf']:
    getattr(libc, name).argtypes = [ctypes.c_float]
    getattr(libc, name).restype = ctypes.c_float
libc.powf.argtypes = [ctypes.c_float, ctypes.c_float]
libc.powf.restype = ctypes.c_float

def expf(x):
    return np.fromiter((libc.expf(float(v)) for v in x.flat), dtype=np.float32, count=x.size).reshape(x.shape)

manifest = json.loads((ROOT / 'manifest.json').read_text())
files = manifest['files']


def quant(x):
    shape = x.shape
    groups = x.reshape(-1, 128)
    maximum = np.max(np.abs(groups), axis=1)
    scale = np.where(maximum > 0, maximum / np.float32(127), np.float32(1)).astype(np.float32)
    v = groups * (np.float32(1) / scale[:, None])
    v64 = v.astype(np.float64)
    q = np.where(v64 >= 0, np.floor(v64 + .5), np.ceil(v64 - .5)).clip(-127, 127).astype(np.int8)
    return q, scale


def unpack(file):
    raw = np.memmap(ROOT / file['name'], dtype=np.uint8, mode='r', offset=128).reshape(file['rows'], file['cols'] // 128, 66)
    scale = raw[..., :2].copy().view('<f2').reshape(raw.shape[:2]).astype(np.float32)
    packed = raw[..., 2:]
    q = np.empty((*packed.shape[:2], 128), dtype=np.int8)
    q[..., 0::2] = ((packed & 15).astype(np.int8) << 4) >> 4
    q[..., 1::2] = packed.view(np.int8) >> 4
    return q, scale


def matrix(tid, x):
    a, a_scale = quant(x)
    parts = []
    for file in files:
        if file['tensor'] != tid: continue
        q, scales = unpack(file)
        # Exact INT32 inner products; float32 scaling and reduction thereafter.
        dots = np.einsum('rgi,gi->rg', q.astype(np.int32), a.astype(np.int32), optimize=False)
        values = dots.astype(np.float32) * scales * a_scale[None, :]
        parts.append(np.cumsum(values, axis=1, dtype=np.float32)[:, -1])
    return np.concatenate(parts)


def vector(tid):
    file = next(f for f in files if f['tensor'] == tid)
    return np.fromfile(ROOT / file['name'], dtype='<f4', offset=128)


def norm(x, w):
    sum_ = np.cumsum(x * x, axis=-1, dtype=np.float32)[..., -1:]
    return x * (np.float32(1) / np.sqrt(sum_ / np.float32(x.shape[-1]) + np.float32(1e-6))) * w


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--native', type=Path, default=Path('/tmp/qwen-native-v2'))
    parser.add_argument('--tokens', default='9707')
    parser.add_argument('--debug', action='store_true')
    args = parser.parse_args()
    cache = [[] for _ in range(LAYERS)]
    errors = []
    def debug(stage, name, expected, offset, dtype):
        raw = np.fromfile(args.native / f'state-{stage}.bin', dtype=np.uint8)
        actual = raw[offset:offset + expected.size * np.dtype(dtype).itemsize].copy().view(dtype).reshape(expected.shape)
        print('DEBUG', name, 'different', int(np.count_nonzero(actual != expected)), 'maxdiff', float(np.max(np.abs(actual.astype(np.float64) - expected.astype(np.float64)))), flush=True)
    for pos, token in enumerate(map(int, args.tokens.split(','))):
        file = next(f for f in files if f['tensor'] == 0 and f['rowStart'] <= token < f['rowStart'] + f['rows'])
        q, scale = unpack(file)
        h = (q[token - file['rowStart']].astype(np.float32) * scale[token - file['rowStart'], :, None]).reshape(D)
        for layer in range(LAYERS):
            base = 3 + layer * 8
            weights = vector(base)
            x = norm(h, weights[:D])
            query = norm(matrix(base + 1, x).reshape(32, HEAD), weights[D * 2:D * 2 + HEAD])
            key = norm(matrix(base + 2, x).reshape(8, HEAD), weights[D * 2 + HEAD:])
            value = matrix(base + 3, x).reshape(8, HEAD)
            angles = np.float32(pos) * np.array([libc.powf(1e6, -2*i/HEAD) for i in range(HEAD//2)], dtype=np.float32)
            sin = np.array([libc.sinf(float(a)) for a in angles], dtype=np.float32)
            cos = np.array([libc.cosf(float(a)) for a in angles], dtype=np.float32)
            def rope(v):
                left, right = v[:, :64], v[:, 64:]
                return np.concatenate((left * cos - right * sin, right * cos + left * sin), axis=-1)
            query, qs = quant(rope(query)); key, ks = quant(rope(key)); value, vs = quant(value)
            cache[layer].append((key, ks, value, vs))
            if args.debug and pos == 1 and layer == 0:
                debug(5, 'query', query, 235392, np.int8)
                debug(5, 'query_scales', qs, 239488, np.float32)
                for head in range(8):
                    debug(5, f'key-{head}', key[head], 239616 + (pos * 16 + head) * 132 + 4, np.int8)
                    debug(5, f'value-{head}', value[head], 239616 + (pos * 16 + 8 + head) * 132 + 4, np.int8)
            attention = np.zeros((32, HEAD), dtype=np.float32)
            for head in range(32):
                kvhead = head // 4
                scores = np.array([np.dot(query[head].astype(np.int32), k[kvhead].astype(np.int32)) for k, _, _, _ in cache[layer]], dtype=np.float32)
                scores = scores * qs[head] * np.array([s[kvhead] for _, s, _, _ in cache[layer]], dtype=np.float32) * np.float32(HEAD**-.5)
                probabilities = expf(scores - scores.max()); denominator = np.cumsum(probabilities, dtype=np.float32)[-1]
                for prob, (_, _, v, s) in zip(probabilities, cache[layer]):
                    attention[head] += prob * (v[kvhead].astype(np.float32) * s[kvhead])
                attention[head] /= denominator
            if args.debug and pos == 1 and layer == 0:
                debug(7, 'attention', attention.reshape(D), 768 + 10240*4, np.float32)
            h += matrix(base + 4, attention.reshape(D))
            x = norm(h, weights[D:D * 2])
            if args.debug and pos == 1 and layer == 0:
                debug(8, 'post_norm', x, 768 + 14336*4, np.float32)
            gate = matrix(base + 5, x); up = matrix(base + 6, x)
            if args.debug and pos == 1 and layer == 0:
                debug(9, 'gate', gate, 768 + 18432*4, np.float32)
                debug(9, 'up', up, 768 + 30720*4, np.float32)
            with np.errstate(over='ignore'):
                act = gate / (np.float32(1) + expf(-gate)) * up
            if args.debug and pos == 1 and layer == 0:
                debug(11, 'act', act, 768 + 43008*4, np.float32)
                qa, sa = quant(act)
                debug(11, 'act_quant', qa.reshape(-1), 222720, np.int8)
                debug(11, 'act_scale', sa, 235008, np.float32)
            down = matrix(base + 7, act)
            if args.debug and pos == 1 and layer == 0:
                debug(11, 'down', down, 768 + 14336*4, np.float32)
            h += down
            actual = np.fromfile(args.native / f'hidden-{pos}-{layer}.f32', dtype='<f4')
            err = float(np.max(np.abs(h - actual)))
            cosine = float(np.dot(h, actual) / (np.linalg.norm(h) * np.linalg.norm(actual)))
            errors.append({'position': pos, 'layer': layer, 'maxAbsError': err, 'cosine': cosine})
            assert cosine > .999, (pos, layer, err, cosine)
            print(json.dumps(errors[-1]), flush=True)
        logits = matrix(2, norm(h, vector(1)))
        actual = np.fromfile(args.native / f'logits-{pos}.f32', dtype='<f4')
        assert len(actual) == len(logits) == 151936
        predicted, expected = int(actual.argmax()), int(logits.argmax())
        top_agreement = len(set(actual.argsort()[-10:]) & set(logits.argsort()[-10:]))
        print(json.dumps({'position': pos, 'native': predicted, 'reference': expected, 'top10Agreement': top_agreement, 'maxLogitError': float(np.max(np.abs(actual-logits)))}), flush=True)
        assert predicted == expected
    report = {'model': manifest['model'], 'revision': manifest['revision'], 'tokens': args.tokens, 'layers': errors, 'passed': True}
    (args.native / 'validation.json').write_text(json.dumps(report, indent=2) + '\n')


if __name__ == '__main__': main()

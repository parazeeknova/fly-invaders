"""Small layered random graph with the same graph.npz / manifest.json layout as prepare.py.

Retina (histaminergic, inhibitory) -> lamina (tonic) -> optic lobe -> visual projection ->
central brain -> descending readouts, split by eye so DNp20 R-L reacts to where light falls.
Lets the server and UI run before the multi-GB MaleCNS download finishes.
"""
import argparse
import json
import numpy as np
from . import OUTPUTS

READOUTS = [('DNp20', 'L'), ('DNp20', 'R'), ('DNpe017', 'L'), ('DNpe017', 'R'), ('DNa02', 'L'), ('DNa02', 'R'),
            ('MN9', 'L'), ('MN9', 'R'), ('DNp09', 'L'), ('DNp09', 'R'), ('MDN', 'L'), ('MDN', 'R')]


def build(n=4000, seed=41027, out=None, gain=3.0):
    """gain scales all contact counts; 3.0 gives balanced dark activity and side-selective DNp20 drive."""
    rng = np.random.default_rng(seed)
    out = out or OUTPUTS / 'synthetic'
    out.mkdir(parents=True, exist_ok=True)
    # Retina: 20x12 grid per eye; left eye covers x in [0, .6], right eye [.4, 1] like prepare.py.
    gx, gy = np.meshgrid(np.linspace(0, 1, 20), np.linspace(0, 1, 12))
    z = np.c_[gx.ravel(), gy.ravel()]; per_eye = len(z)
    uv = np.r_[np.c_[.60 * z[:, 0], z[:, 1]], np.c_[.40 + .60 * (1 - z[:, 0]), z[:, 1]]].astype(np.float32)
    eye_side = np.asarray(['L'] * per_eye + ['R'] * per_eye, dtype='U1')
    # Layer layout (contiguous index blocks).
    layers = [('retina', 2 * per_eye), ('lamina', 2 * per_eye), ('sugar', 8), ('ol', 1200), ('vpn', 400), ('cb', 0), ('readout', len(READOUTS))]
    sizes = dict(layers); sizes['cb'] = n - sum(sizes.values())
    start, block = 0, {}
    for name, _ in layers:
        block[name] = np.arange(start, start + sizes[name], dtype=np.int32); start += sizes[name]
    superclass = np.empty(n, dtype='U64'); cell_type = np.full(n, 'unknown', dtype='U16')
    superclass[block['retina']] = 'sensory'; cell_type[block['retina']] = 'R1-R6'
    superclass[block['lamina']] = 'ol_intrinsic'; cell_type[block['lamina']] = 'L1'
    superclass[block['sugar']] = 'sensory'; cell_type[block['sugar']] = 'LB3c'
    superclass[block['ol']] = 'ol_intrinsic'; superclass[block['vpn']] = 'visual_projection'
    superclass[block['cb']] = rng.choice(['cb_intrinsic', 'cb_intrinsic', 'cb_intrinsic', 'motor'], sizes['cb'])
    for i, (typ, side) in zip(block['readout'], READOUTS):
        cell_type[i] = typ; superclass[i] = 'motor' if typ == 'MN9' else 'descending_neuron'
    # Side of every visual neuron: first half of each visual block is left, second half right.
    def halves(ix): return ix[:len(ix) // 2], ix[len(ix) // 2:]
    side_of = {'L': {}, 'R': {}}
    for name in ['retina', 'lamina', 'ol', 'vpn']:
        side_of['L'][name], side_of['R'][name] = halves(block[name])
    readout_side = {'L': block['readout'][0::2], 'R': block['readout'][1::2]}
    pre, post, w = [], [], []
    def connect(src, dst, k, contacts, sign):
        pre.append(np.repeat(src, k)); post.append(rng.choice(dst, size=len(src) * k))
        w.append(sign * rng.integers(contacts[0], contacts[1] + 1, size=len(src) * k))
    for side in 'LR':
        s = side_of[side]
        rng = np.random.default_rng(seed + 1)          # mirror-symmetric eyes: same draws per side
        # Photoreceptor i inhibits its own lamina cartridge plus neighbours.
        for offset in (0, 1, 20):
            src, dst = s['retina'], np.roll(s['lamina'], -offset)
            pre.append(src); post.append(dst); w.append(-rng.integers(20, 40, size=len(src)))
        connect(s['lamina'], s['ol'], 12, (4, 10), +1)
        connect(s['ol'], s['ol'], 8, (1, 6), rng.choice([-1, 1], size=1, p=[.3, .7])[0])
        connect(s['ol'], s['vpn'], 10, (3, 8), +1)
        connect(s['vpn'], readout_side[side], 6, (2, 5), +1)
        connect(s['vpn'], block['cb'], 15, (1, 5), +1)
    rng = np.random.default_rng(seed + 2)
    connect(block['cb'], np.r_[block['cb'], block['readout']], 20, (1, 4), +1)
    connect(block['sugar'], block['cb'], 20, (2, 6), +1)
    pre = np.concatenate(pre).astype(np.int64); post = np.concatenate(post).astype(np.int32)
    w = np.concatenate([x.astype(np.float64) for x in w])
    # Central-brain neurons get a random excitatory/inhibitory identity (70/30).
    cb_sign = np.where(rng.random(n) < .7, 1, -1)
    cb_edges = np.isin(pre, block['cb'])
    w[cb_edges] = np.abs(w[cb_edges]) * cb_sign[pre[cb_edges]]
    weight = (w * .275 * gain).astype(np.float32)
    order = np.argsort(pre, kind='stable')
    ptr = np.r_[0, np.cumsum(np.bincount(pre, minlength=n))].astype(np.int64)
    ids = (10_000_000 + np.arange(n)).astype(np.int64)
    readouts = [{'index': int(i), 'id': str(ids[i]), 'type': typ, 'side': side} for i, (typ, side) in zip(block['readout'], READOUTS)]
    np.savez(out / 'graph.npz', ptr=ptr, post=post[order], weight=weight[order], ids=ids,
             retina=block['retina'], uv=uv, retina_side=eye_side, confidence=np.ones(2 * per_eye), hexes=np.tile(z, (2, 1)),
             lamina=block['lamina'], sugar=block['sugar'], superclass=superclass,
             side=np.asarray(rng.choice(['L', 'R'], n), dtype='U1'))
    manifest = {'dataset': 'synthetic', 'synthetic': True, 'neurons': n, 'edges': int(len(post)),
                'synaptic_contacts': int(np.abs(w).sum()), 'retina_total': 2 * per_eye, 'retina_mapped': 2 * per_eye,
                'retina_unmapped': 0, 'uncertain_sign_neurons': 0, 'readouts': readouts,
                'retina_model': 'Synthetic grid retina; layered random graph for UI/server smoke tests.'}
    (out / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps({k: v for k, v in manifest.items() if k != 'readouts'}))
    return manifest


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--neurons', type=int, default=4000); p.add_argument('--seed', type=int, default=41027)
    p.add_argument('--gain', type=float, default=3.0)
    a = p.parse_args(); build(a.neurons, a.seed, gain=a.gain)

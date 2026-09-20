"""Compile all retained edges into CSR + inferred retinal projection -> graph.npz + manifest.json."""
import json
import numpy as np
import pyarrow as pa
import pyarrow.feather as feather
import pyarrow.ipc as ipc
from . import DATA, OUTPUTS
from .transmitters import transmitter_signs

READOUT_TYPES = ['DNa02', 'DNp09', 'MDN', 'MN9', 'DNp20', 'DNpe017']


def prepare(dataset='malecns_v1'):
    root = DATA / dataset
    nodes = feather.read_table(root / 'normalized/neurons.feather').to_pandas()
    edges = ipc.open_file(pa.memory_map(str(root / 'normalized/edges.arrow'), 'r')).read_all()
    pre, post, count = [edges.column(k).to_numpy() for k in ['pre_index', 'post_index', 'synapse_count']]
    del edges
    # CSR stores every released edge, including self edges and weak edges.
    order = np.argsort(pre, kind='stable')
    ptr = np.r_[0, np.cumsum(np.bincount(pre, minlength=len(nodes)))].astype(np.int64)
    signs, uncertain = transmitter_signs(nodes.neurotransmitter)
    weight = (count[order].astype(np.float32) * signs[pre[order]] * .275).astype(np.float32)
    a = feather.read_table(root / 'annotations.feather').to_pandas().set_index('bodyId')
    a.index = a.index.astype(np.int64)
    a = a.loc[nodes.source_id.to_numpy().astype(np.int64)]
    receptor = a.type.eq('R1-R6').to_numpy()
    anchors = a.type.isin(['L1', 'L2', 'L3']).to_numpy() & a.assignedOlHex1.notna().to_numpy()
    selected = receptor[pre] & anchors[post]
    # Infer each photoreceptor's column from its R1-R6 -> L1/L2/L3 contacts (modal column).
    hex1, hex2 = a.assignedOlHex1.to_numpy(), a.assignedOlHex2.to_numpy()
    cols = {}
    for i, j, w in zip(pre[selected], post[selected], count[selected]):
        key = (float(hex1[j]), float(hex2[j]))
        d = cols.setdefault(int(i), {}); d[key] = d.get(key, 0) + int(w)
    indices, xy, confidence, hexes = [], [], [], []
    for i, counts in sorted(cols.items()):
        h = max(counts, key=counts.get); total = sum(counts.values())
        indices.append(i); hexes.append(h); confidence.append(counts[h] / total)
        xy.append((h[0] - .5 * h[1], np.sqrt(3) / 2 * h[1]))     # axial hex grid embedding
    xy = np.asarray(xy); indices = np.asarray(indices, dtype=np.int32)
    uv = np.empty_like(xy)
    sides = a.rootSide.to_numpy()[indices].astype('U1')
    for side in ['L', 'R']:
        mask = sides == side; z = xy[mask]; z = (z - z.min(axis=0)) / (z.max(axis=0) - z.min(axis=0))
        # Overlapping left/right viewports on the screen.
        uv[mask, 0] = (.60 * z[:, 0] if side == 'L' else .40 + .60 * (1 - z[:, 0]))
        uv[mask, 1] = 1 - z[:, 1]
    # Hemisphere per neuron for region telemetry: soma side, else root side, else '?'.
    soma = a.somaSide.astype(object).where(a.somaSide.notna(), a.rootSide.astype(object)).fillna('?').astype(str).to_numpy()
    side = np.asarray([x[0].upper() if x and x[0].upper() in 'LRM' else '?' for x in soma], dtype='U1')
    readouts = [{'index': int(i), 'id': str(nodes.source_id.iloc[i]), 'type': str(nodes.cell_type.iloc[i]), 'side': str(a.somaSide.iloc[i])}
                for i in np.flatnonzero(nodes.cell_type.isin(READOUT_TYPES).to_numpy())]
    manifest = {'dataset': dataset, 'synthetic': False, 'neurons': len(nodes), 'edges': len(pre),
                'synaptic_contacts': int(count.sum(dtype=np.uint64)),
                'retina_total': int(receptor.sum()), 'retina_mapped': len(indices), 'retina_unmapped': int(receptor.sum()) - len(indices),
                'uncertain_sign_neurons': int(uncertain.sum()), 'projection_confidence_median': float(np.median(confidence)),
                'readouts': readouts,
                'retina_model': 'R1-R6 luminance-only. Column inferred from contacts onto annotated L1/L2/L3; overlapping viewport projection, not calibrated retinal angles.',
                'motor_interface': 'Fixed readouts: BCI (DNp20 R-L moves; DNpe017 spikes fire) or biological-role comparison (DNa02 R-L moves; MN9 fires). Gains are engineering mappings.'}
    out = OUTPUTS / dataset; out.mkdir(parents=True, exist_ok=True)
    np.savez(out / 'graph.npz', ptr=ptr, post=post[order].astype(np.int32), weight=weight,
             ids=nodes.source_id.to_numpy(dtype=np.int64), retina=indices, uv=uv.astype(np.float32),
             retina_side=sides, side=side, confidence=np.asarray(confidence), hexes=np.asarray(hexes),
             lamina=np.flatnonzero(nodes.cell_type.isin(['L1', 'L2', 'L3', 'L5']).to_numpy()).astype(np.int32),
             sugar=np.flatnonzero(nodes.cell_type.eq('LB3c').to_numpy()).astype(np.int32),
             superclass=np.asarray(nodes.superclass.fillna('unassigned').astype(str), dtype='U64'))
    (out / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps({k: v for k, v in manifest.items() if k != 'readouts'}))
    return manifest


if __name__ == '__main__':
    prepare()

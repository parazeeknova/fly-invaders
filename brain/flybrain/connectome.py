"""Import the MaleCNS v1.0 flat connectome into normalized node/edge tables.

Keeps every annotated neuronal entry (any superclass, excluding Glia) and every
released edge between retained entries. Stores topology + annotations only.
"""
import argparse
import json
from pathlib import Path
import numpy as np
from . import ROOT, DATA

REGISTRY = ROOT / 'datasets.json'


def exact_ids(values) -> np.ndarray:
    """Never round 64-bit biological IDs through floating point."""
    items = np.asarray(values)
    if items.dtype.kind == 'f':
        raise ValueError('Neuron IDs must be integers or decimal strings, never floats.')
    if items.dtype.kind in 'iu':
        if np.any(items < 0): raise ValueError('Neuron IDs cannot be negative.')
        return items.astype(np.uint64)
    text = [str(v) for v in items]
    if any(not v.isascii() or not v.isdecimal() for v in text):
        raise ValueError('Neuron IDs must be nonnegative decimal integers.')
    return np.asarray(text, dtype=np.uint64)


def index_edges(ids, pre, post, counts):
    """Map (pre, post) body IDs to node indices; drop edges touching non-retained bodies."""
    pre, post = exact_ids(pre), exact_ids(post)
    counts = np.asarray(counts)
    i, j = np.searchsorted(ids, pre), np.searchsorted(ids, post)
    keep = (i < len(ids)) & (j < len(ids))
    keep &= ids[np.minimum(i, len(ids) - 1)] == pre
    keep &= ids[np.minimum(j, len(ids) - 1)] == post
    return i[keep].astype(np.uint32), j[keep].astype(np.uint32), counts[keep].astype(np.uint32)


def normalize_nodes(frame, nt_frame):
    """Sorted node table with superclass, cell type, neurotransmitter."""
    import pandas as pd
    source = exact_ids(frame.bodyId)
    retain = frame.superclass.notna() & frame.superclass.astype(str).ne('') & ~frame.status.eq('Glia')
    nt = nt_frame.set_index('body')
    if not nt.index.is_unique: raise ValueError('Duplicate neurotransmitter IDs.')
    nodes = pd.DataFrame({
        'source_id': source, 'superclass': np.asarray(frame.superclass), 'cell_type': np.asarray(frame.type),
        'neurotransmitter': np.asarray(frame.bodyId.map(nt.consensus_nt)),
    })[np.asarray(retain, dtype=bool)].sort_values('source_id', ignore_index=True)
    nodes.insert(0, 'node_index', np.arange(len(nodes), dtype=np.uint32))
    return nodes


def import_graph(dataset='malecns_v1'):
    import pyarrow as pa
    import pyarrow.feather as feather
    import pyarrow.ipc as ipc
    config = json.loads(REGISTRY.read_text())['datasets'][dataset]
    source_dir = DATA / dataset
    output = source_dir / 'normalized'
    output.mkdir(parents=True, exist_ok=True)
    print('reading annotations', flush=True)
    frame = feather.read_table(source_dir / 'annotations.feather').to_pandas()
    nt_frame = feather.read_table(source_dir / 'neurotransmitters.feather').to_pandas()
    nodes = normalize_nodes(frame, nt_frame)
    del frame, nt_frame
    feather.write_feather(nodes, output / 'neurons.feather')
    ids = exact_ids(nodes.source_id)
    print(f'{len(ids)} neurons retained; streaming edges', flush=True)
    reader = ipc.open_file(pa.memory_map(str(source_dir / 'edges.feather'), 'r'))
    schema = pa.schema([('pre_index', pa.uint32()), ('post_index', pa.uint32()), ('synapse_count', pa.uint32())])
    stats = {'source_edge_rows': 0, 'retained_edge_rows': 0, 'retained_synaptic_contacts': 0}
    temporary = output / 'edges.arrow.partial'
    with pa.OSFile(str(temporary), 'wb') as sink, ipc.new_file(sink, schema) as writer:
        for number in range(reader.num_record_batches):
            batch = reader.get_batch(number)
            pre, post, weights = [batch.column(batch.schema.get_field_index(c)).to_numpy(zero_copy_only=False) for c in ('body_pre', 'body_post', 'weight')]
            i, j, count = index_edges(ids, pre, post, weights)
            stats['source_edge_rows'] += len(pre); stats['retained_edge_rows'] += len(i)
            stats['retained_synaptic_contacts'] += int(count.sum(dtype=np.uint64))
            writer.write_batch(pa.record_batch([pa.array(i), pa.array(j), pa.array(count)], schema=schema))
            if number % 20 == 0: print(f'  batch {number + 1}/{reader.num_record_batches}: {stats["retained_edge_rows"]} edges', flush=True)
    temporary.replace(output / 'edges.arrow')
    report = {'dataset': dataset, 'release': config['release'], 'neurons': len(nodes),
              'superclass_counts': nodes.superclass.fillna('unknown').value_counts().to_dict(), 'graph': stats}
    (output / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({k: report[k] for k in ['dataset', 'neurons', 'graph']}, indent=2))
    return report


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('dataset', nargs='?', default='malecns_v1', choices=['malecns_v1'])
    import_graph(p.parse_args().dataset)


if __name__ == '__main__':
    main()

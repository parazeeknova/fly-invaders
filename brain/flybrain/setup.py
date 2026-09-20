"""One-shot, resumable setup: download -> connectome import -> prepare -> build native kernel."""
import sys
from . import DATA, OUTPUTS


def main(dataset='malecns_v1'):
    from .download import download
    print('[1/4] download', flush=True); download(dataset)
    normalized = DATA / dataset / 'normalized'
    if (normalized / 'edges.arrow').exists() and (normalized / 'neurons.feather').exists():
        print('[2/4] connectome import: already done', flush=True)
    else:
        print('[2/4] connectome import', flush=True)
        from .connectome import import_graph; import_graph(dataset)
    if (OUTPUTS / dataset / 'graph.npz').exists() and (OUTPUTS / dataset / 'manifest.json').exists():
        print('[3/4] prepare: already done', flush=True)
    else:
        print('[3/4] prepare graph', flush=True)
        from .prepare import prepare; prepare(dataset)
    from .native import LIBRARY_NAME
    if (OUTPUTS / dataset / LIBRARY_NAME).exists():
        print('[4/4] native kernel: already built', flush=True)
    else:
        print('[4/4] build native kernel', flush=True)
        from .build_kernel import build; build(OUTPUTS / dataset / LIBRARY_NAME)
    print('setup complete:', OUTPUTS / dataset)


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'malecns_v1')

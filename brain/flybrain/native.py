"""Native C++ implementation of the same fixed-step model (much faster than numba)."""
import ctypes as C
import hashlib
import json
import os
import sys
import time
import warnings
from pathlib import Path
import numpy as np
from . import OUTPUTS
from .engine import Brain

LIBRARY_NAME = 'libneural.dylib' if sys.platform == 'darwin' else 'libneural.so'
SOURCE = Path(__file__).with_name('kernel.cpp')


def library_path(dataset='malecns_v1'):
    return Path(os.environ.get('FLYBRAIN_KERNEL_PATH', str(OUTPUTS / dataset / LIBRARY_NAME)))


def default_threads(n):
    """Physical cores work best; small graphs are barrier-bound, so give them fewer threads."""
    if os.environ.get('FLYBRAIN_THREADS'): return int(os.environ['FLYBRAIN_THREADS'])
    cores = max(1, (os.cpu_count() or 2) // 2)
    return max(1, min(cores, 12, n // 12000))


def load_kernel(path, threads=0):
    """Load libneural; warn (do not fail) if it was built from a different kernel.cpp."""
    os.environ.setdefault('OMP_WAIT_POLICY', 'active')  # spin at barriers: lower step latency
    path = Path(path)
    record = path.with_suffix(path.suffix + '.json')
    if record.exists():
        build = json.loads(record.read_text())
        if build.get('kernel_source_sha256') != hashlib.sha256(SOURCE.read_bytes()).hexdigest():
            warnings.warn(f'{path.name} was built from a different kernel.cpp; run python -m flybrain.build_kernel')
    lib = C.CDLL(str(path))
    fn = lib.neural_advance
    fn.argtypes = [C.c_int] + [C.c_void_p] * 11 + [C.c_int, C.c_float] + [C.c_void_p] * 5
    fn.restype = None
    used = 1
    if hasattr(lib, 'neural_set_threads'):
        lib.neural_set_threads.argtypes = [C.c_int]; lib.neural_set_threads.restype = C.c_int
        used = lib.neural_set_threads(int(threads))
    return fn, used


class NativeBrain(Brain):
    def __init__(self, path, dt=.1, library=None):
        super().__init__(path, dt)
        self._advance, self.threads = load_kernel(library or library_path(), default_threads(self.n))
        self.previous_drive = np.zeros(self.n, dtype=np.float32)
        self.last = np.full(self.n, -1, dtype=np.int64)

    def step(self, luminance, duration_ms, sugar=False, lamina_bias=12.0):
        steps = self._prepare(luminance, duration_ms, sugar, lamina_bias)
        clock = np.asarray([self.cursor], dtype=np.int64)
        arrays = [self.ptr, self.post, self.weight, self.v, self.g, self.refractory, self.drive, self.previous_drive, self.queue, self.queue_count, clock]
        start = time.perf_counter()
        self._advance(self.n, *[x.ctypes.data for x in arrays], steps, self.dt,
                      *[x.ctypes.data for x in [self.counts, self.active, self.active_flag, self.nactive, self.last]])
        wall = time.perf_counter() - start
        self.cursor = int(clock[0]); self.total_spikes += int(self.counts.sum()); self.sim_ms += steps * self.dt
        return self.counts.copy(), wall

"""Compiled all-edge LIF simulation (numba). Same constants as DOOMFLY.

Analytic subthreshold integration, threshold check each 0.1 ms, 1.8 ms transmission
delay, 2.2 ms refractory period. Retina and lamina use a coarse spiking proxy.
"""
import math
import time
import numpy as np
from numba import njit


@njit(cache=True)
def advance(ptr, post, weight, v, g, refractory, drive, queue, queue_count, cursor, steps, dt, counts, active, active_flag, nactive):
    av = math.exp(-dt / 20); ag = math.exp(-dt / 5)
    coupling = (av - ag) / 3
    delay_slots = queue.shape[0]
    for step in range(steps):
        # Delivery occurs after integration/threshold and before reset. A spike at
        # tick t arrives at t+18 for dt=.1.
        slot = cursor % delay_slots
        for k in range(nactive[0]):
            i = active[k]
            if refractory[i] > 0: refractory[i] -= 1
            if refractory[i] == 0:
                v[i] = -52 + (v[i] + 52) * av + drive[i] * (1 - av) + g[i] * coupling
                g[i] *= ag
                if v[i] > -45:
                    counts[i] += 1
                    future = (cursor + int(round(1.8 / dt))) % delay_slots
                    queue[future, queue_count[future]] = i
                    queue_count[future] += 1
        for q in range(queue_count[slot]):
            i = queue[slot, q]
            for e in range(ptr[i], ptr[i + 1]):
                j = post[e]
                # Refractory neurons ignore synaptic writes (Brian2 "unless refractory").
                if refractory[j] > 0: continue
                g[j] += weight[e]
                if active_flag[j] == 0:
                    active_flag[j] = 1; active[nactive[0]] = j; nactive[0] += 1
        queue_count[slot] = 0
        future = (cursor + int(round(1.8 / dt))) % delay_slots
        for q in range(queue_count[future]):
            i = queue[future, q]; v[i] = -52; g[i] = 0; refractory[i] = int(round(2.2 / dt))
        cursor += 1
    return cursor


class Brain:
    """Whole-graph LIF brain loaded from graph.npz (real or synthetic)."""
    MODEL = 'lif-r2-refractory-write-protection'

    def __init__(self, path, dt=.1):
        if dt != .1: raise ValueError('This kernel supports only dt=0.1 ms.')
        a = np.load(path)
        for k in ['ptr', 'post', 'weight', 'ids', 'retina', 'uv', 'lamina', 'sugar', 'superclass']:
            setattr(self, k, a[k])
        n = len(self.ids)
        for k, dtype in [('ptr', np.int64), ('post', np.int32), ('weight', np.float32), ('ids', np.int64),
                         ('retina', np.int32), ('lamina', np.int32), ('sugar', np.int32)]:
            x = getattr(self, k)
            if x.ndim != 1 or x.dtype != dtype or not x.flags.c_contiguous: raise ValueError(f'Invalid graph array: {k}')
        if n < 1 or self.ptr.shape != (n + 1,) or self.ptr[0] != 0 or self.ptr[-1] != len(self.post) or np.any(np.diff(self.ptr) < 0) or len(self.weight) != len(self.post):
            raise ValueError('Invalid CSR graph')
        if not np.isfinite(self.weight).all(): raise ValueError('Nonfinite synaptic weight')
        for x in [self.post, self.retina, self.lamina, self.sugar]:
            if np.any(x < 0) or np.any(x >= n): raise ValueError('Graph index out of bounds')
        if self.uv.shape != (len(self.retina), 2) or not np.isfinite(self.uv).all() or np.any(self.uv < 0) or np.any(self.uv > 1):
            raise ValueError('Invalid receptor UV coordinates')
        self.retina_side = a['retina_side'].astype('U1') if 'retina_side' in a.files else np.where(self.uv[:, 0] < .5, 'L', 'R').astype('U1')
        self.side = a['side'].astype('U1') if 'side' in a.files else None  # per-neuron hemisphere (L/R/M/?) for region telemetry
        self.dt = dt; self.n = n; self.cursor = 0
        self.v = np.full(n, -52, dtype=np.float32); self.g = np.zeros(n, dtype=np.float32)
        self.drive = np.zeros(n, dtype=np.float32); self.refractory = np.zeros(n, dtype=np.int16)
        self.queue = np.zeros((int(round(1.8 / dt)) + 1, n), dtype=np.int32)
        self.queue_count = np.zeros(self.queue.shape[0], dtype=np.int32)
        self.counts = np.zeros(n, dtype=np.int32)
        self.luminance = np.zeros(len(self.retina), dtype=np.float32)
        self.active = np.zeros(n, dtype=np.int32); self.active_flag = np.zeros(n, dtype=np.uint8)
        initial = np.unique(np.r_[self.retina, self.lamina, self.sugar])
        self.active[:len(initial)] = initial; self.active_flag[initial] = 1
        self.nactive = np.asarray([len(initial)], dtype=np.int32)
        self.total_spikes = 0; self.sim_ms = 0.0

    def _prepare(self, luminance, duration_ms, sugar, lamina_bias):
        """Shared input handling: validate, low-pass luminance, set drive currents."""
        if len(luminance) != len(self.retina) or not np.all(np.isfinite(luminance)):
            raise ValueError('A finite luminance sample is required for every mapped receptor')
        if not math.isfinite(duration_ms) or not math.isfinite(lamina_bias): raise ValueError('Finite duration and current required')
        steps = int(round(duration_ms / self.dt))
        if steps < 1: raise ValueError('Duration too short')
        # 10 ms discrete low-pass, updated once per supplied frame interval.
        alpha = 1 - math.exp(-steps * self.dt / 10)
        self.luminance += alpha * (np.clip(luminance, 0, 1) - self.luminance)
        self.drive.fill(0)
        self.drive[self.lamina] = lamina_bias          # tonic lamina current
        self.drive[self.retina] = 30 * self.luminance / (.02 + self.luminance)
        if sugar: self.drive[self.sugar] = 30
        self.counts.fill(0)
        return steps

    def step(self, luminance, duration_ms, sugar=False, lamina_bias=12.0):
        """Integrate `duration_ms` of neural time. Returns (spike counts, wall seconds)."""
        steps = self._prepare(luminance, duration_ms, sugar, lamina_bias)
        start = time.perf_counter()
        self.cursor = advance(self.ptr, self.post, self.weight, self.v, self.g, self.refractory, self.drive,
                              self.queue, self.queue_count, self.cursor, steps, self.dt, self.counts, self.active, self.active_flag, self.nactive)
        elapsed = time.perf_counter() - start
        self.total_spikes += int(self.counts.sum()); self.sim_ms += steps * self.dt
        return self.counts.copy(), elapsed

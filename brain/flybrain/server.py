"""WebSocket brain server for Fly Invaders (see ../../PROTOCOL.md).

ws://127.0.0.1:8766/ws  lockstep frame -> action loop; GET /health and GET /state over plain HTTP.
"""
import argparse
import asyncio
import base64
import json
import logging
import math
import signal
import time
import uuid
from collections import deque
from http import HTTPStatus
import numpy as np
import websockets
from websockets.asyncio.server import serve
from . import OUTPUTS
from .controls import NeuralControls
from .engine import Brain
from .retina import retinal_samples
from .reward import SugarReinforcement

log = logging.getLogger('flybrain')
DISPLAY_STRIDE = 8
TELEMETRY_HZ = 8
RASTER_SUPERCLASSES = ['ol_intrinsic', 'visual_projection', 'cb_intrinsic', 'descending_neuron']
CHECKPOINT_FIELDS = ['v', 'g', 'refractory', 'drive', 'previous_drive', 'queue', 'queue_count', 'counts', 'luminance', 'active', 'active_flag', 'nactive', 'last']
MANIFEST_KEYS = ['neurons', 'edges', 'synaptic_contacts', 'retina_mapped', 'retina_total', 'retina_unmapped', 'uncertain_sign_neurons', 'dataset', 'synthetic']


def load_brain(graph, native):
    """Build NativeBrain (compiling libneural if needed) or fall back to the numba Brain."""
    path = OUTPUTS / graph / 'graph.npz'
    if native:
        from .native import LIBRARY_NAME, NativeBrain
        candidates = [OUTPUTS / graph / LIBRARY_NAME, OUTPUTS / 'malecns_v1' / LIBRARY_NAME]
        library = next((c for c in candidates if c.exists()), None)
        if library is None:
            try:
                from .build_kernel import build
                library = build(candidates[0])
            except Exception as e:
                log.warning('native kernel unavailable (%s); using numba kernel', e)
        if library is not None:
            return NativeBrain(path, library=library), 'native'
    return Brain(path), 'numba'


class BrainServer:
    def __init__(self, args):
        self.args = args
        self.run_id = str(uuid.uuid4())
        self.status = {'type': 'status', 'status': 'loading', 'message': f'loading graph {args.graph}', 'progress': 0.0}
        self.ready = asyncio.Event()
        self.clients = set()            # every open connection that completed hello
        self.env = None                 # the environment connection
        self.hello = {}                 # connection -> hello dict
        self.lock = asyncio.Lock()      # one brain step at a time
        self.brain = None; self.controls = None; self.reward = SugarReinforcement(args.reward == 'sugar')
        self.latest = None; self.sequence = 0; self.last_publish = 0.0
        self.timeline = deque(maxlen=50); self.episodes = deque(maxlen=12)
        self.total_action_ticks = 0; self.last_game = None; self.last_action = {'move': 0.0, 'fire': False}
        self.last_step_ms = 0.0; self.last_light = None; self.last_counts = None
        self.tick_offset = 0; self.global_tick = 0
        self.env_started = time.monotonic(); self.env_neural_start = 0.0
        self.last_log = 0.0
        self.checkpoint_path = OUTPUTS / args.graph / 'checkpoint.npz'
        self.last_checkpoint = time.monotonic()
        self.resumed = None

    # ---------------------------------------------------------------- loading
    async def load(self):
        try:
            self.brain, kernel = await asyncio.to_thread(load_brain, self.args.graph, self.args.native)
            self.manifest = json.loads((OUTPUTS / self.args.graph / 'manifest.json').read_text())
            self.controls = NeuralControls(self.manifest['readouts'], mode=self.args.decoder, centering=self.args.centering, move_gain=self.args.move_gain, fire_mode=self.args.fire, rate_tau=self.args.rate_tau, agc=self.args.agc)
            b = self.brain
            names = np.unique(b.superclass)
            self.groups = [(str(k), np.flatnonzero(b.superclass == k)) for k in names]
            self.regions = None
            if getattr(b, 'side', None) is not None:
                self.regions = [(str(k), str(sd), np.flatnonzero((b.superclass == k) & (b.side == sd)))
                                for k in names for sd in ['L', 'R', 'M', '?'] if np.any((b.superclass == k) & (b.side == sd))]
            display = []
            for superclass in RASTER_SUPERCLASSES:
                inds = np.flatnonzero(b.superclass == superclass)
                display.extend(inds[np.linspace(0, len(inds) - 1, min(32, len(inds)), dtype=int)].tolist())
            self.display = np.asarray(display, dtype=np.int64)
            self.window_counts = np.zeros(b.n, dtype=np.int32); self.window_ms = 0.0
            self.last_light = np.zeros(len(b.retina), dtype=np.float32); self.last_counts = np.zeros(b.n, dtype=np.int32)
            threads = getattr(b, 'threads', 1)
            note = ''
            if self.args.resume and self.checkpoint_path.exists():
                try:
                    self.resumed = self.restore_checkpoint()
                    note = f' · resumed: {self.resumed["neural_seconds"]:.0f} s of brain time, {self.resumed["rounds"]} rounds'
                except Exception as e:
                    log.warning('checkpoint ignored: %s', e)
            self.status = {'type': 'status', 'status': 'ready', 'message': f'{self.manifest["dataset"]}: {b.n} neurons, {len(b.post)} edges ({kernel} kernel, {threads} threads){note}', 'progress': 1.0}
            log.info(self.status['message'])
        except Exception:
            log.exception('failed to load brain')
            self.status = {'type': 'status', 'status': 'error', 'message': 'failed to load graph; see server log'}
        self.ready.set()
        await self.broadcast(self.status)

    # ---------------------------------------------------------------- messages
    def welcome(self):
        b, m = self.brain, self.manifest
        s = slice(None, None, DISPLAY_STRIDE)
        return {'type': 'welcome', 'protocol': 1, 'run_id': self.run_id, 'decoder': self.args.decoder, 'phase': 'resumed' if self.resumed else 'baseline',
                'manifest': {k: m.get(k) for k in MANIFEST_KEYS},
                'readouts': [{k: r[k] for k in ['index', 'id', 'type', 'side']} for r in m['readouts']],
                'retina': {'uv': b.uv[s].round(4).tolist(), 'side': b.retina_side[s].tolist(),
                           'neuron_ids': [str(x) for x in b.ids[b.retina[s]]], 'full_sample_count': len(b.retina), 'display_stride': DISPLAY_STRIDE},
                'raster_ids': [str(x) for x in b.ids[self.display]],
                'raster_groups': [str(x) for x in b.superclass[self.display]],
                'populations': [name for name, _ in self.groups],
                'protocol_info': {'dt_ms': b.dt, 'lamina_bias_mv': 12, 'retinal_gain_mv': 30, 'photoreceptor_half_saturation': .02,
                                  'seed': self.args.seed, 'model': Brain.MODEL}}

    def telemetry(self, action, fps):
        b = self.brain; s = slice(None, None, DISPLAY_STRIDE); now = time.monotonic()
        self.sequence += 1
        wall = max(now - self.env_started, 1e-9); neural = b.sim_ms / 1000
        window_s = max(self.window_ms / 1000, 1e-9)
        t = {'sequence': self.sequence, 'generated_at_ms': int(time.time() * 1000),
             'clocks': {'wall_seconds': round(wall, 3), 'neural_seconds': round(neural, 4), 'game_seconds': round(self.global_tick / fps, 4),
                        'speed': round((neural - self.env_neural_start) / wall, 3), 'brain_step_ms': round(self.last_step_ms, 3)},
             'game': self.last_game, 'episodes': list(self.episodes),
             'action': {'move': action['move'], 'fire': action['fire']}, 'readouts': action['readouts'],
             'total_spikes': b.total_spikes, 'window_spikes': int(self.window_counts.sum()), 'window_ms': round(self.window_ms, 2),
             'total_action_ticks': self.total_action_ticks,
             'populations': [{'name': name, 'neurons': len(ix), 'spikes': int(self.window_counts[ix].sum()),
                              'mean_rate_hz': round(float(self.window_counts[ix].sum() / len(ix) / window_s), 4)} for name, ix in self.groups],
             'regions': [{'name': name, 'side': sd, 'neurons': len(ix), 'spikes': int(self.window_counts[ix].sum()),
                          'mean_rate_hz': round(float(self.window_counts[ix].sum() / len(ix) / window_s), 4)} for name, sd, ix in self.regions] if self.regions else None,
             'retina': {'luminance': self.last_light[s].round(4).tolist(), 'filtered_luminance': b.luminance[s].round(4).tolist(),
                        'drive_mv': b.drive[b.retina[s]].round(4).tolist(), 'spikes_last_step': self.last_counts[b.retina[s]].tolist()},
             'raster_bin': {'neural_ms': round(b.sim_ms, 1), 'window_ms': round(self.window_ms, 3),
                            'counts': self.window_counts[self.display].tolist(), 'population_spikes': int(self.window_counts.sum())},
             'timeline': list(self.timeline),
             'neuron_voltage_mv': {r['id']: round(float(b.v[r['index']]), 3) for r in self.manifest['readouts']},
             'reward': {'mode': self.args.reward, 'sugar_pulses': self.reward.pulses, 'active': self.reward.active(b.sim_ms), 'plasticity': False}}
        self.window_counts.fill(0); self.window_ms = 0.0; self.last_publish = now
        return t

    async def on_frame(self, ws, frame):
        hello = self.hello[ws]; b = self.brain
        w, h, fps = hello['width'], hello['height'], hello['fps']
        pixels = np.frombuffer(frame['pixel_bytes'] if 'pixel_bytes' in frame else base64.b64decode(frame['pixels']), dtype=np.uint8)
        if pixels.size != w * h * 3:
            raise ValueError(f'frame has {pixels.size} bytes, expected {w}x{h}x3')
        rgb = pixels.reshape(h, w, 3)
        light = retinal_samples(rgb, b.uv)
        tick = int(frame['tick'])
        # Keep neural time monotonic even if the client restarts its tick counter.
        steps = round((tick + self.tick_offset) * 10000 / fps) - b.cursor
        if steps < 1:
            # Client restarted its tick count (or we resumed a long checkpoint): re-anchor in one jump.
            self.tick_offset = math.ceil((b.cursor + 1) * fps / 10000) - tick
            steps = round((tick + self.tick_offset) * 10000 / fps) - b.cursor
            while steps < 1:
                self.tick_offset += 1
                steps = round((tick + self.tick_offset) * 10000 / fps) - b.cursor
        self.global_tick = tick + self.tick_offset
        async with self.lock:
            counts, wall = await asyncio.to_thread(b.step, light, steps * .1, self.reward.active(b.sim_ms))
            if self.args.checkpoint_seconds and time.monotonic() - self.last_checkpoint >= self.args.checkpoint_seconds:
                try: self.save_checkpoint()
                except Exception as e: log.warning('checkpoint failed: %s', e)
        action = self.controls.decode(counts, steps * .1 / 1000)
        self.reward.observe(float(frame.get('reward', 0.0)), b.sim_ms)
        if frame.get('ended'): self.episodes.append(frame['ended'])
        self.last_game = frame.get('game'); self.last_action = {'move': action['move'], 'fire': action['fire']}
        self.last_step_ms = wall * 1000; self.last_light = light; self.last_counts = counts
        self.total_action_ticks += int(abs(action['move']) > 1e-9 or action['fire'])
        self.timeline.append({'tick': tick, 'spikes': int(counts.sum()), 'move': action['move'], 'fire': action['fire']})
        self.window_counts += counts; self.window_ms += steps * .1
        now = time.monotonic()
        telemetry = self.telemetry(action, fps) if now - self.last_publish >= 1 / TELEMETRY_HZ else None
        if telemetry: self.latest = telemetry
        message = {'type': 'action', 'tick': tick, 'move': action['move'], 'fire': action['fire'], 'move_raw': action.get('move_raw', action['move']), 'move_bias': action.get('move_bias', 0.0), 'neural_ms': round(steps * .1, 3),
                   'steps': steps, 'readouts': action['readouts'], 'telemetry': telemetry}
        await ws.send(json.dumps(message))
        if telemetry:
            await self.broadcast(message, exclude=ws)
        if now - self.last_log >= 1:
            self.last_log = now
            speed = (b.sim_ms / 1000 - self.env_neural_start) / max(now - self.env_started, 1e-9)
            print(f'tick {tick} neural_ms {b.sim_ms:.1f} speed {speed:.3f}x spikes {int(counts.sum())} move {action["move"]:+.3f} fire {action["fire"]} step {wall * 1000:.1f}ms', flush=True)

    # ---------------------------------------------------------------- checkpoints
    def save_checkpoint(self):
        """Atomically persist the full neural state, decoder state and round history."""
        b = self.brain
        if b is None: return
        arrays = {k: getattr(b, k) for k in CHECKPOINT_FIELDS if hasattr(b, k)}
        meta = {'neurons': b.n, 'cursor': b.cursor, 'sim_ms': b.sim_ms, 'total_spikes': b.total_spikes,
                'total_action_ticks': self.total_action_ticks, 'episodes': list(self.episodes),
                'controls': {'rates': self.controls.rates.tolist(), 'bias': self.controls.bias, 'fire_bias': self.controls.fire_bias},
                'reward': {'until_ms': self.reward.until_ms, 'pulses': self.reward.pulses}, 'saved_at': time.time()}
        tmp = self.checkpoint_path.with_suffix('.partial.npz')
        np.savez(tmp, meta=json.dumps(meta), **arrays)
        tmp.replace(self.checkpoint_path)
        self.last_checkpoint = time.monotonic()
        log.info('checkpoint saved: %.0f s brain time, %d rounds', b.sim_ms / 1000, len(self.episodes))

    def restore_checkpoint(self):
        b = self.brain
        with np.load(self.checkpoint_path, allow_pickle=False) as saved:
            meta = json.loads(str(saved['meta']))
            if meta['neurons'] != b.n: raise ValueError('checkpoint is for a different graph')
            for k in CHECKPOINT_FIELDS:
                if k in saved.files and hasattr(b, k):
                    target = getattr(b, k)
                    if target.shape != saved[k].shape: raise ValueError(f'shape mismatch in {k}')
                    target[:] = saved[k]
        b.cursor, b.sim_ms, b.total_spikes = int(meta['cursor']), float(meta['sim_ms']), int(meta['total_spikes'])
        self.total_action_ticks = int(meta['total_action_ticks'])
        self.episodes.extend(meta['episodes'])
        c = meta['controls']
        if len(c['rates']) == len(self.controls.rates): self.controls.rates[:] = c['rates']
        self.controls.bias, self.controls.fire_bias = float(c['bias']), float(c['fire_bias'])
        self.reward.until_ms, self.reward.pulses = float(meta['reward']['until_ms']), int(meta['reward']['pulses'])
        self.global_tick = 0
        return {'neural_seconds': b.sim_ms / 1000, 'rounds': len(self.episodes), 'saved_at': meta['saved_at']}

    def new_run(self):
        self.run_id = str(uuid.uuid4()); self.timeline.clear()  # round history is kept across runs and checkpoints
        self.tick_offset = self.global_tick; self.env_started = time.monotonic()
        self.env_neural_start = self.brain.sim_ms / 1000 if self.brain else 0.0

    async def take_env(self, ws):
        """Newest env hello wins: demote the previous driver to spectator (its game falls back to keyboard)."""
        if self.env is ws: return
        old, self.env = self.env, ws
        self.new_run()
        if old is not None:
            try: await old.send(json.dumps({'type': 'role', 'role': 'spectator'}))
            except Exception: pass

    async def promote(self):
        """The driver left: hand the brain to the most recent remaining tab that asked to drive."""
        candidates = [c for c in self.hello if c in self.clients and self.hello[c].get('role') == 'env']  # insertion order = connection order
        if not candidates or self.brain is None: return
        ws = candidates[-1]; self.env = ws; self.new_run()
        try:
            await ws.send(json.dumps({'type': 'role', 'role': 'env'}))
            await ws.send(json.dumps(self.welcome()))
        except Exception: pass

    async def broadcast(self, message, exclude=None):
        data = json.dumps(message)
        for ws in list(self.clients):
            if ws is exclude: continue
            try: await ws.send(data)
            except Exception: pass

    # ---------------------------------------------------------------- connection
    async def handler(self, ws):
        role = 'spectator'
        try:
            hello = json.loads(await ws.recv())
            if hello.get('type') != 'hello': raise ValueError('first message must be hello')
            for k, d in [('width', 160), ('height', 120), ('fps', 60)]: hello[k] = int(hello.get(k) or d)
            if min(hello['width'], hello['height'], hello['fps']) < 1: raise ValueError('width, height and fps must be positive')
            self.hello[ws] = hello; self.clients.add(ws)
            if hello.get('role') == 'env':
                await self.take_env(ws); role = 'env'
            log.info('client connected as %s (%s %dx%d @ %d fps)', role, hello.get('env'), hello['width'], hello['height'], hello['fps'])
            if not self.ready.is_set():
                await ws.send(json.dumps(self.status)); await self.ready.wait()
            if ws is self.env and self.brain is not None:
                self.env_neural_start = self.brain.sim_ms / 1000; self.env_started = time.monotonic()
            await ws.send(json.dumps(self.status))
            if self.brain is None: return
            await ws.send(json.dumps({'type': 'role', 'role': 'env' if ws is self.env else 'spectator'}))
            await ws.send(json.dumps(self.welcome()))
            running = False
            async for raw in ws:
                try:
                    if isinstance(raw, (bytes, bytearray)):
                        # Binary frame: uint32 LE header length, JSON header, raw RGB bytes.
                        n = int.from_bytes(raw[:4], 'little')
                        message = json.loads(raw[4:4 + n]); message['pixel_bytes'] = raw[4 + n:]
                    else:
                        message = json.loads(raw)
                    if message.get('type') == 'hello':
                        # Scene switch: same socket, new environment. Keep the brain state, start a new run.
                        for k, d in [('width', 160), ('height', 120), ('fps', 60)]: message[k] = int(message.get(k) or d)
                        self.hello[ws] = message
                        if message.get('role') == 'env': await self.take_env(ws)
                        if ws is self.env: self.new_run()
                        await ws.send(json.dumps({'type': 'role', 'role': 'env' if ws is self.env else 'spectator'}))
                        await ws.send(json.dumps(self.welcome())); continue
                    if message.get('type') != 'frame': log.warning('ignoring message type %r', message.get('type')); continue
                    if ws is not self.env:
                        await ws.send(json.dumps({'type': 'role', 'role': 'spectator'})); continue
                    if not running:
                        running = True; self.status = {'type': 'status', 'status': 'running', 'message': 'environment connected'}
                        await self.broadcast(self.status)
                    await self.on_frame(ws, message)
                except (websockets.ConnectionClosed, asyncio.CancelledError): raise
                except Exception as e:
                    log.warning('bad message ignored: %s', e)
        except websockets.ConnectionClosed: pass
        except Exception as e:
            log.warning('connection error: %s', e)
        finally:
            self.clients.discard(ws); self.hello.pop(ws, None)
            if ws is self.env:
                self.env = None
                self.status = {'type': 'status', 'status': 'ready', 'message': 'environment disconnected; brain state kept'}
                await self.broadcast(self.status)
                await self.promote()
            log.info('%s disconnected', role)

    def process_request(self, connection, request):
        """Plain HTTP endpoints; anything else proceeds to the WebSocket handshake on /ws."""
        path = request.path.split('?')[0]
        if path == '/ws': return None
        if path == '/health':
            body = {'status': self.status['status'], 'run_id': self.run_id, 'sequence': self.sequence,
                    'generated_at_ms': self.latest['generated_at_ms'] if self.latest else 0}
        elif path == '/state':
            body = self.latest or {}
        else:
            return connection.respond(HTTPStatus.NOT_FOUND, 'not found\n')
        response = connection.respond(HTTPStatus.OK, json.dumps(body))
        response.headers['Content-Type'] = 'application/json'
        response.headers['Access-Control-Allow-Origin'] = '*'
        response.headers['Cache-Control'] = 'no-store'
        return response

    async def serve(self):
        asyncio.create_task(self.load())
        async with serve(self.handler, self.args.bind, self.args.port, process_request=self.process_request, max_size=None, compression=None):
            log.info('listening on ws://%s:%d/ws (GET /health, /state)', self.args.bind, self.args.port)
            await asyncio.Future()


def default_graph():
    return 'malecns_v1' if (OUTPUTS / 'malecns_v1' / 'graph.npz').exists() else 'synthetic'


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--graph', choices=['malecns_v1', 'synthetic'], default=default_graph())
    p.add_argument('--decoder', choices=['bci', 'biological'], default='bci')
    p.add_argument('--reward', choices=['off', 'sugar'], default='off')
    p.add_argument('--centering', action=argparse.BooleanOptionalAction, default=True, help='subtract a slow running mean of the left/right drive')
    p.add_argument('--checkpoint-seconds', type=int, default=60, help='save the full neural + decoder state this often (0 = never)')
    p.add_argument('--resume', action=argparse.BooleanOptionalAction, default=True, help='restore outputs/<graph>/checkpoint.npz on start')
    p.add_argument('--rate-tau', type=float, default=0.25, help='seconds; exponential filter for readout firing rates')
    p.add_argument('--agc', action=argparse.BooleanOptionalAction, default=True, help='normalise the centered move drive by its running amplitude')
    p.add_argument('--move-gain', type=float, default=0.06, help='ship speed fraction per Hz of DNp20 right-minus-left rate')
    p.add_argument('--fire', choices=['spike', 'burst'], default='burst', help="'spike': any DNpe017 spike fires; 'burst': only spikes above the cell's running mean")
    p.add_argument('--seed', type=int, default=41027)
    p.add_argument('--port', type=int, default=8766); p.add_argument('--bind', default='127.0.0.1')
    p.add_argument('--native', action=argparse.BooleanOptionalAction, default=True, help='use the C++ kernel (libneural.so) when available')
    args = p.parse_args()
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    if not (OUTPUTS / args.graph / 'graph.npz').exists():
        p.error(f'{OUTPUTS / args.graph / "graph.npz"} missing; run python -m flybrain.synthetic or python -m flybrain.setup')
    server = BrainServer(args)
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    try:
        asyncio.run(server.serve())
    except KeyboardInterrupt:
        pass
    finally:
        if args.checkpoint_seconds:
            try: server.save_checkpoint()
            except Exception as e: log.warning('final checkpoint failed: %s', e)


if __name__ == '__main__':
    main()

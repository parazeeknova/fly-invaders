"""Minimal environment client: sends black frames as role "env" and prints actions."""
import argparse
import asyncio
import base64
import json
import time
import numpy as np
import websockets


async def run(url, ticks, width, height, fps, bright):
    async with websockets.connect(url, max_size=None) as ws:
        await ws.send(json.dumps({'type': 'hello', 'protocol': 1, 'role': 'env', 'env': 'empty', 'width': width, 'height': height, 'fps': fps}))
        while True:
            msg = json.loads(await ws.recv())
            print('<-', msg['type'], msg.get('status', ''), msg.get('message', ''))
            if msg['type'] == 'welcome':
                print('   manifest:', {k: msg['manifest'][k] for k in ['dataset', 'synthetic', 'neurons', 'edges']},
                      '| readouts:', len(msg['readouts']), '| retina sample:', len(msg['retina']['uv']), '| raster:', len(msg['raster_ids']))
                break
        frame = np.zeros((height, width, 3), dtype=np.uint8)
        if bright: frame[:, width // 2:] = 255           # light on the right half
        pixels = base64.b64encode(frame.tobytes()).decode()
        started = time.monotonic(); telemetry = 0
        for tick in range(1, ticks + 1):
            await ws.send(json.dumps({'type': 'frame', 'tick': tick, 'pixels': pixels,
                                      'game': {'round': 1, 'tick': tick - 1, 'score': 0, 'lives': 3, 'aliens': 0, 'finished': False, 'ship_x': .5},
                                      'reward': 1.0 if tick % 40 == 0 else 0.0,
                                      **({'ended': {'round': 1, 'ticks': tick, 'score': 0, 'lives': 3}} if tick == ticks // 2 else {})}))
            while True:
                msg = json.loads(await ws.recv())
                if msg['type'] == 'action' and msg['tick'] == tick: break
            telemetry += msg['telemetry'] is not None
            if tick % 10 == 0 or tick == 1:
                spikes = sum(r['spikes'] for r in msg['readouts'])
                print(f'tick {tick:4d} steps {msg["steps"]} neural_ms {msg["neural_ms"]:.1f} move {msg["move"]:+.3f} fire {msg["fire"]} readout_spikes {spikes}'
                      + (f' | telemetry seq {msg["telemetry"]["sequence"]} speed {msg["telemetry"]["clocks"]["speed"]} total_spikes {msg["telemetry"]["total_spikes"]}' if msg['telemetry'] else ''))
        wall = time.monotonic() - started
        print(f'done: {ticks} ticks in {wall:.1f}s ({ticks / wall:.1f} ticks/s), {telemetry} telemetry payloads')


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--url', default='ws://127.0.0.1:8766/ws'); p.add_argument('--ticks', type=int, default=100)
    p.add_argument('--width', type=int, default=160); p.add_argument('--height', type=int, default=120); p.add_argument('--fps', type=int, default=60)
    p.add_argument('--bright', action='store_true', help='light up the right half of the frame')
    a = p.parse_args()
    asyncio.run(run(a.url, a.ticks, a.width, a.height, a.fps, a.bright))

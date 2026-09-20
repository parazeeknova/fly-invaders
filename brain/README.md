# brain/ - the fly brain half of Fly Invaders

A whole-connectome leaky-integrate-and-fire simulation of the MaleCNS v1.0 fruit-fly
brain (~167k neurons, ~25M edges), extracted from the DOOMFLY reference project and
served over a WebSocket so the browser game in `../web/` can be driven by it.
Wire protocol: [`../PROTOCOL.md`](../PROTOCOL.md).

## Run

```sh
cd brain && uv sync

uv run python -m flybrain.synthetic        # instant 4000-neuron demo graph -> outputs/synthetic/
uv run python -m flybrain.server --graph synthetic

uv run python -m flybrain.setup            # real MaleCNS: ~1.1 GB download + import + prepare + kernel build
                                           # (needs ~8 GB RAM and several GB disk; resumable, re-run to continue)
uv run python -m flybrain.server           # defaults to malecns_v1 when outputs/malecns_v1/graph.npz exists
```

Server: `ws://127.0.0.1:8766/ws`, `GET /health`, `GET /state`.
Options: `--graph {malecns_v1,synthetic}`, `--decoder {bci,biological}`, `--reward {off,sugar}`,
`--centering/--no-centering` (subtract a 3 s running mean of the left/right drive; on by default),
`--agc/--no-agc` (normalise the centered drive by its running amplitude), `--rate-tau 0.25`
(readout rate filter in seconds), `--fire {burst,spike}` (burst = spike while the cell's rate is
above its running mean; spike = DOOMFLY's any-spike rule), `--move-gain`,
`--seed`, `--port`, `--native/--no-native` (C++ kernel `libneural.so`, built automatically if a
C++ compiler is found; otherwise the numba kernel is used).

Checkpoints: `--checkpoint-seconds 60` (default) saves the full neural + decoder state and round
history to `outputs/<graph>/checkpoint.npz`, also on SIGTERM/Ctrl-C; `--resume` (default) restores it.

The C++ kernel is OpenMP-parallel: each thread owns a fixed slice of neurons (integration and
incoming spikes), so results are deterministic for a given thread count and match the serial
kernel. It picks physical-core count by default (`FLYBRAIN_THREADS=n` to override). On a 14-core
laptop the full graph steps 16.7 ms of neural time in ~11 ms, i.e. faster than realtime.

Quick end-to-end check without the browser (sends black frames, prints actions):

```sh
uv run python -m flybrain.fake_env --ticks 100 [--bright]
```

## Layout

| file | role |
| --- | --- |
| `flybrain/download.py` | fetch the three MaleCNS files (`datasets.json`), verify sha256 (`source.lock.json`) |
| `flybrain/connectome.py` | normalize annotations + stream edges into `connectome_data/malecns_v1/normalized/` |
| `flybrain/prepare.py` | CSR graph, transmitter signs, R1-R6 retinal UV projection, readouts -> `outputs/malecns_v1/graph.npz` + `manifest.json` |
| `flybrain/engine.py` | numba LIF kernel (`Brain`) |
| `flybrain/kernel.cpp`, `native.py`, `build_kernel.py` | identical model in C++ (`NativeBrain`), much faster |
| `flybrain/retina.py` | bilinear linear-luma sampling of the frame at receptor UVs |
| `flybrain/controls.py` | fixed readout decoder (DNp20 R-L -> move, DNpe017 -> fire) |
| `flybrain/reward.py` | optional 200 ms LB3c "sugar" pulse on positive reward |
| `flybrain/server.py` | asyncio websockets server implementing PROTOCOL.md |
| `flybrain/synthetic.py` | small random graph with the same file layout |
| `flybrain/setup.py` | download -> import -> prepare -> build, skipping finished steps |

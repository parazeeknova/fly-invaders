"""Download the MaleCNS v1.0 flat-connectome files and verify sha256 against source.lock.json."""
import hashlib
import json
import sys
import time
import urllib.request
from . import ROOT, DATA

REGISTRY = ROOT / 'datasets.json'
LOCK = ROOT / 'source.lock.json'


def sha256(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(8 * 1024 ** 2), b''): h.update(block)
    return h.hexdigest()


def fetch(url, path, expected_bytes):
    """Stream `url` to `path`, resuming a partial file if the server allows it."""
    partial = path.with_suffix(path.suffix + '.partial')
    have = partial.stat().st_size if partial.exists() else 0
    request = urllib.request.Request(url, headers={'Range': f'bytes={have}-'} if have else {})
    try:
        response = urllib.request.urlopen(request, timeout=60)
    except urllib.error.HTTPError as e:
        if e.code == 416 and have == expected_bytes:            # already complete
            partial.replace(path); return
        raise
    if response.status == 200 and have:                            # server ignored Range; restart
        have = 0
    mode = 'ab' if response.status == 206 else 'wb'
    started = time.monotonic(); last = 0
    with partial.open(mode) as f:
        while chunk := response.read(4 * 1024 ** 2):
            f.write(chunk); have += len(chunk)
            if time.monotonic() - last > 1:
                rate = have / max(time.monotonic() - started, 1e-9) / 1024 ** 2
                print(f'\r  {path.name}: {have / 1024 ** 2:.0f}/{expected_bytes / 1024 ** 2:.0f} MB ({100 * have / expected_bytes:.1f}%, {rate:.1f} MB/s)', end='', flush=True)
                last = time.monotonic()
    print()
    partial.replace(path)


def download(dataset='malecns_v1'):
    files = json.loads(REGISTRY.read_text())['datasets'][dataset]['files']
    lock = json.loads(LOCK.read_text())
    target = DATA / dataset
    target.mkdir(parents=True, exist_ok=True)
    for name, url in files.items():
        path = target / name
        if path.exists() and sha256(path) == lock[name]['sha256']:
            print(f'  {name}: present and verified', flush=True); continue
        if path.exists(): print(f'  {name}: checksum mismatch, re-downloading', flush=True); path.unlink()
        for attempt in range(5):
            try:
                fetch(url, path, lock[name]['bytes']); break
            except Exception as e:
                print(f'  {name}: download error ({e}), retrying', flush=True); time.sleep(5)
        else:
            raise RuntimeError(f'Failed to download {name}')
        digest = sha256(path)
        if digest != lock[name]['sha256']:
            path.unlink(); raise RuntimeError(f'{name}: sha256 {digest} != {lock[name]["sha256"]}')
        print(f'  {name}: verified', flush=True)
    return target


if __name__ == '__main__':
    download(sys.argv[1] if len(sys.argv) > 1 else 'malecns_v1')

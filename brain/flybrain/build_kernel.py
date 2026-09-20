"""Compile kernel.cpp into outputs/<dataset>/libneural.so (clang++ -> g++ -> c++, or $CXX)."""
import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import os
from pathlib import Path
from . import OUTPUTS
from .native import LIBRARY_NAME, SOURCE


def compilers():
    seen = []
    for c in [os.environ.get('CXX'), 'g++', 'clang++', 'c++']:
        if c and shutil.which(c) and c not in seen: seen.append(c)
    if not seen: raise RuntimeError('No C++ compiler found (tried $CXX, g++, clang++, c++)')
    return seen


BASE = ['-O3', '-std=c++17', '-shared', '-fPIC']
# Try the fast build first (OpenMP threads + native SIMD), then plain.
FLAG_SETS = [BASE + ['-fopenmp', '-march=native'], BASE + ['-march=native'], BASE]


def build(output=None):
    out = Path(output) if output else OUTPUTS / 'malecns_v1' / LIBRARY_NAME
    out.parent.mkdir(parents=True, exist_ok=True)
    temporary = out.with_suffix(out.suffix + '.partial')
    last_error = None
    for cxx in compilers():
        for flags in FLAG_SETS:
            command = [cxx, *flags, str(SOURCE), '-o', str(temporary)]
            result = subprocess.run(command, capture_output=True, text=True)
            if result.returncode == 0:
                break
            last_error = result.stderr.strip().splitlines()[-1] if result.stderr.strip() else 'compile failed'
        else:
            continue
        break
    else:
        raise RuntimeError(f'Could not build the native kernel: {last_error}')
    print('built native kernel:', ' '.join(command), flush=True)
    record = {'kernel_source_sha256': hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
              'binary_sha256': hashlib.sha256(temporary.read_bytes()).hexdigest(),
              'model_revision': 'lif-r2-refractory-write-protection-parallel', 'compiler': cxx, 'compile_flags': flags,
              'openmp': '-fopenmp' in flags}
    temporary.replace(out)
    out.with_suffix(out.suffix + '.json').write_text(json.dumps(record, indent=2) + '\n')
    print(json.dumps(record))
    return out


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--output', type=Path)
    build(p.parse_args().output)


if __name__ == '__main__':
    main()

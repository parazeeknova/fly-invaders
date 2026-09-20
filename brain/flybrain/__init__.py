"""Fly Invaders brain: MaleCNS whole-connectome LIF simulator extracted from DOOMFLY."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]          # brain/
DATA = ROOT / "connectome_data"
OUTPUTS = ROOT / "outputs"

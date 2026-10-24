"""Register two unmodified upstream KJNodes memory nodes; see LICENSE and source-lock.json."""
import hashlib
import json
from pathlib import Path

_root = Path(__file__).resolve().parent
_lock = json.loads((_root / "source-lock.json").read_text(encoding="utf-8"))
if hashlib.sha256((_root / "minimax_nodes.py").read_bytes()).hexdigest() != _lock["sourceSha256"]:
    raise ImportError("H3 memory node source does not match source-lock.json")

from .minimax_nodes import MiniMaxChunkFeedForward, MiniMaxLowVRAMAttention

NODE_CLASS_MAPPINGS = {
    "MiniMaxLowVRAMAttention": MiniMaxLowVRAMAttention,
    "MiniMaxChunkFeedForward": MiniMaxChunkFeedForward,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "MiniMaxLowVRAMAttention": "MiniMax H3 Low VRAM Attention (pinned KJNodes)",
    "MiniMaxChunkFeedForward": "MiniMax H3 Chunk FeedForward (pinned KJNodes)",
}

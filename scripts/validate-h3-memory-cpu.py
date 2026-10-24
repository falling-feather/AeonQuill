"""Compare the pinned memory patches with the installed core on small CPU tensors.

This checks computation and import compatibility; it does not evaluate model quality.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import sys
import types
sys.dont_write_bytecode = True

parser = argparse.ArgumentParser()
parser.add_argument('--comfy-root', type=Path, required=True)
parser.add_argument('--report', type=Path, required=True)
arguments = parser.parse_args()
root = Path(__file__).resolve().parents[1]
core = arguments.comfy_root.resolve(strict=True)
report = arguments.report.resolve()
assert report.parent.is_dir(), 'Report parent must already exist'
os.environ['CUDA_VISIBLE_DEVICES'] = '-1'
sys.argv = ['validate-h3-memory-cpu', '--cpu']
sys.path.insert(0, str(core))

import comfy.options
comfy.options.enable_args_parsing()

import torch
torch.set_num_threads(2)
torch.manual_seed(20261024)
from comfy.ldm.minimax.model import MLP, Attention, DiTBlock
import comfyui_version

package = root / 'desktop/runtime/h3-native-memory'
spec = importlib.util.spec_from_file_location('aeonquill_h3_memory_validation', package / '__init__.py', submodule_search_locations=[str(package)])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
patches = sys.modules[spec.name + '.minimax_nodes']
results = []

def compare(name, expected, actual):
    torch.testing.assert_close(actual, expected, rtol=2e-5, atol=2e-6)
    results.append({'case': name, 'shape': list(actual.shape), 'maxAbsoluteDifference': float((actual - expected).abs().max())})

with torch.inference_mode():
    for tokens in [31, 4097]:
        mlp = MLP(32, 48, dtype=torch.float32, device='cpu', operations=torch.nn)
        values = torch.randn(tokens, 32)
        expected = mlp(values)
        mlp.kj_num_chunks = 4
        mlp.kj_seq_threshold = 4096
        compare('feed-forward-' + str(tokens), expected, patches.minimax_mlp_chunked_forward(mlp, values))

    attention = Attention(224, 56, 4, 1e-6, dtype=torch.float32, device='cpu', operations=torch.nn)
    values = torch.randn(31, 224)
    expected = attention(values)
    for chunks in [8, 10]:
        compare('attention-heads-' + str(chunks), expected, patches.minimax_attn_lowmem_forward(attention, values, transformer_options={'minimax_head_chunks': chunks}))

    block = DiTBlock(224, 56, 4, 256, 8, 1e-6, 1e-6, dtype=torch.float32, device='cpu', operations=torch.nn)
    values = torch.randn(31, 224)
    time = torch.randn(1, 8)
    segments = [(0, 31, 0)]
    expected = block(values.clone(), time, segments, None)
    block.attn.forward = types.MethodType(patches.minimax_attn_lowmem_forward, block.attn)
    block.mlp.kj_num_chunks = 4
    block.mlp.kj_seq_threshold = 16
    block.mlp.forward = types.MethodType(patches.minimax_mlp_chunked_forward, block.mlp)
    compare('combined-block', expected, patches.minimax_block_lowmem_forward(block, values.clone(), time, segments, None, {'minimax_head_chunks': 8}))

assert not torch.cuda.is_initialized(), 'CPU validation must not create a CUDA context'
payload = {'status': 'passed', 'scope': 'small CPU tensors, import and computation only; not pretrained-model quality', 'core': comfyui_version.__version__, 'torch': torch.__version__, 'cudaContextInitialized': False, 'sourceCommit': json.loads((package/'source-lock.json').read_text(encoding='utf-8'))['sourceCommit'], 'results': results}
report.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps(payload, ensure_ascii=False))

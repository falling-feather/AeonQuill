"""Compare the pinned memory patches with the installed core on small CPU tensors.

This checks computation and import compatibility; it does not evaluate model quality.
"""
import argparse
import importlib.util
import importlib
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
reuse = importlib.import_module(spec.name + '.attention_reuse')
results = []
interface_checks = []


class PatchModel:
    def __init__(self, blocks):
        self.diffusion_model = types.SimpleNamespace(blocks=blocks)
        self.model_options = {'transformer_options': {}}
        self.object_patches = {}

    def clone(self):
        clone = PatchModel(self.diffusion_model.blocks)
        clone.model_options = {'transformer_options': self.model_options['transformer_options'].copy()}
        clone.object_patches = self.object_patches.copy()
        return clone

    def get_model_object(self, name):
        assert name == 'diffusion_model'
        return self.diffusion_model

    def add_object_patch(self, name, value):
        self.object_patches[name] = value

def compare(name, expected, actual):
    torch.testing.assert_close(actual, expected, rtol=2e-5, atol=2e-6)
    results.append({'case': name, 'shape': list(actual.shape), 'maxAbsoluteDifference': float((actual - expected).abs().max())})

with torch.inference_mode():
    for tokens in [31, 4097]:
        projection = torch.nn.Linear(32, 96)
        values = torch.randn(tokens, 32)
        compare(f'row-projection-{tokens}', projection(values), reuse.project_rows(projection, values, chunks=16, threshold=16))
    for tokens in [31, 4097]:
        mlp = MLP(32, 48, dtype=torch.float32, device='cpu', operations=torch.nn)
        values = torch.randn(tokens, 32)
        expected = mlp(values)
        mlp.kj_seq_threshold = 4096
        for chunks in [4, 16]:
            mlp.kj_num_chunks = chunks
            compare(f'feed-forward-{tokens}-chunks-{chunks}', expected, patches.minimax_mlp_chunked_forward(mlp, values))

    attention = Attention(224, 56, 4, 1e-6, dtype=torch.float32, device='cpu', operations=torch.nn)
    values = torch.randn(31, 224)
    expected = attention(values)
    for chunks in [8, 10, 28]:
        compare('attention-heads-' + str(chunks), expected, patches.minimax_attn_lowmem_forward(attention, values, transformer_options={'minimax_head_chunks': chunks}))
    for chunks in [1, 8, 10, 28, 56]:
        compare('reuse-attention-heads-' + str(chunks), expected, reuse.attention_forward(attention, values, transformer_options={'minimax_head_chunks': chunks, 'aeonquill_h3_projection_chunks': 16}))
    original_attention = patches.optimized_attention
    staged_groups = []
    def check_staging(q, k, v, heads, **kwargs):
        assert all(tensor.is_contiguous() for tensor in [q, k, v]), 'A head group must be staged contiguously'
        assert q.shape[1] == heads == 2 and q.shape[2] == values.shape[0], 'Keep the complete sequence within a bounded head group'
        staged_groups.append(heads)
        return original_attention(q, k, v, heads, **kwargs)
    try:
        patches.optimized_attention = check_staging
        compare('reuse-contiguous-full-sequence-head-groups', expected, reuse.attention_forward(attention, values, transformer_options={'minimax_head_chunks': 28}))
        assert len(staged_groups) == 28
        interface_checks.append('bounded-contiguous-full-sequence-head-staging')
    finally:
        patches.optimized_attention = original_attention

    block = DiTBlock(224, 56, 4, 256, 8, 1e-6, 1e-6, dtype=torch.float32, device='cpu', operations=torch.nn)
    values = torch.randn(31, 224)
    time = torch.randn(1, 8)
    segments = [(0, 31, 0)]
    expected = block(values.clone(), time, segments, None)
    block.attn.forward = types.MethodType(patches.minimax_attn_lowmem_forward, block.attn)
    block.mlp.kj_seq_threshold = 16
    block.mlp.forward = types.MethodType(patches.minimax_mlp_chunked_forward, block.mlp)
    for heads, chunks in [(8, 4), (28, 16)]:
        block.mlp.kj_num_chunks = chunks
        compare(f'combined-block-heads-{heads}-ff-{chunks}', expected, patches.minimax_block_lowmem_forward(block, values.clone(), time, segments, None, {'minimax_head_chunks': heads}))
    block.attn.forward = types.MethodType(reuse.attention_forward, block.attn)
    compare('reuse-combined-block', expected, patches.minimax_block_lowmem_forward(block, values.clone(), time, segments, None, {'minimax_head_chunks': 28, 'aeonquill_h3_projection_chunks': 16}))

    node = module.NODE_CLASS_MAPPINGS['MiniMaxReuseQKVAttention']
    assert node.define_schema().node_id == 'MiniMaxReuseQKVAttention'
    original = PatchModel([block])
    patched = node.execute(original, 28, 16)[0]
    assert not original.object_patches and original.model_options == {'transformer_options': {}}
    assert patched.object_patches['diffusion_model.blocks.0.attn.forward'].__func__ is reuse.attention_forward
    assert patched.object_patches['diffusion_model.blocks.0.forward'].__func__ is patches.minimax_block_lowmem_forward
    assert patched.model_options['transformer_options']['aeonquill_h3_projection_chunks'] == 16
    interface_checks.append('node-schema-and-isolated-model-patch')
    for heads, projections in [(0, 16), (57, 16), (28, 0), (28, 65), (28, True), (28, 1.5)]:
        try:
            node.execute(original, heads, projections)
        except ValueError:
            continue
        raise AssertionError('Invalid chunk setting was accepted')
    interface_checks.append('invalid-chunk-settings-rejected')
    for model in [PatchModel([]), patched]:
        try:
            node.execute(model, 28, 16)
        except ValueError:
            continue
        raise AssertionError('An incompatible model or attention patch was accepted')
    interface_checks.append('unsupported-model-and-patch-conflict-rejected')
    try:
        patches.mm.in_training = True
        try:
            reuse.attention_forward(attention, values)
        except RuntimeError:
            interface_checks.append('training-rejected')
        else:
            raise AssertionError('Training must not use in-place inference buffer reuse')
    finally:
        patches.mm.in_training = False

assert not torch.cuda.is_initialized(), 'CPU validation must not create a CUDA context'
payload = {'status': 'passed', 'scope': 'small CPU tensors, import and computation only; not pretrained-model quality', 'core': comfyui_version.__version__, 'torch': torch.__version__, 'cudaContextInitialized': False, 'sourceCommit': json.loads((package/'source-lock.json').read_text(encoding='utf-8'))['sourceCommit'], 'results': results, 'interfaceChecks': interface_checks}
report.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps(payload, ensure_ascii=False))

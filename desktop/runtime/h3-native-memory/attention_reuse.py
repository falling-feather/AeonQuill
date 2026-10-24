"""Inference-only H3 buffer reuse, derived from the pinned GPL-3.0 KJNodes source.

Every head still attends to the complete sequence. Only independent token-row
projections are chunked, and consumed Q heads become attention output storage.
"""
import types
import torch
from comfy_api.latest import io
from . import minimax_nodes as upstream


def release_unused_cuda_cache(tensor):
    if tensor.is_cuda:
        torch.cuda.empty_cache()


def project_rows(project, values, chunks=16, threshold=4096):
    if values.ndim != 2:
        raise ValueError("H3 packed projection requires a 2D token matrix")
    if chunks <= 1 or values.shape[0] <= threshold:
        return project(values)
    parts = torch.chunk(values, chunks, dim=0)
    first = project(parts[0])
    output = torch.empty((values.shape[0], first.shape[-1]), dtype=first.dtype, device=first.device)
    offset = first.shape[0]
    output[:offset].copy_(first)
    del first
    for part in parts[1:]:
        value = project(part)
        output[offset:offset + value.shape[0]].copy_(value)
        offset += value.shape[0]
        del value
    return output


def attention_forward(self, x, rope_freqs=None, transformer_options=None):
    if upstream.mm.in_training:
        raise RuntimeError("H3 QKV buffer reuse is inference-only")
    options = transformer_options if isinstance(transformer_options, dict) else {}
    if isinstance(x, list):
        x = x.pop()
    size, dtype, device = x.shape[0], x.dtype, x.device
    chunks = options.get("aeonquill_h3_projection_chunks", 16)
    release_unused_cuda_cache(x)
    qkv = project_rows(self.qkv_proj, x, chunks)
    del x
    if qkv.dtype != dtype:
        raise RuntimeError("H3 QKV buffer reuse requires matching projection and input dtypes")
    inner = self.heads * self.head_dim
    q, k, v = qkv.split(inner, dim=-1)
    v = v.view(size, self.heads, self.head_dim)
    if rope_freqs is not None:
        q = q.view(1, size, self.heads, self.head_dim)
        k = k.view(1, size, self.heads, self.head_dim)
        qw = upstream.mm.cast_to(self.q_norm.weight, device=device)
        kw = upstream.mm.cast_to(self.k_norm.weight, device=device)
        rot = rope_freqs.shape[-3] * 2
        upstream.comfy.quant_ops.ck.rms_rope_split_half_(q, k, rope_freqs, qw, kw, epsilon=self.q_norm.eps, rot_dim=rot)
        q, k = q[0], k[0]
    else:
        q = self.q_norm(q.view(size, self.heads, self.head_dim))
        k = self.k_norm(k.view(size, self.heads, self.head_dim))
    q = q.transpose(0, 1).unsqueeze(0)
    k = k.transpose(0, 1).unsqueeze(0)
    v = v.transpose(0, 1).unsqueeze(0)
    groups = min(options.get("minimax_head_chunks", 1), self.heads)
    output = qkv[:, :inner]
    # Inactive projection/norm allocations otherwise compete with offloaded
    # model weights during the long full-sequence attention kernels on WDDM.
    release_unused_cuda_cache(output)
    start = 0
    for count in [self.heads // groups + (1 if i < self.heads % groups else 0) for i in range(groups)]:
        end = start + count
        # Stage only this head group. Reading the large packed QKV row stride
        # repeatedly inside SDPA is costly when WDDM pages that storage.
        q_group = q[:, start:end].contiguous()
        k_group = k[:, start:end].contiguous()
        v_group = v[:, start:end].contiguous()
        value = upstream.optimized_attention(q_group, k_group, v_group, count, mask=None, skip_reshape=True, transformer_options=options)
        # This head group has been consumed on the current stream; future groups
        # use disjoint Q channels, while K and V remain untouched.
        output[:, start * self.head_dim:end * self.head_dim].copy_(value.squeeze(0))
        start = end
        del value, q_group, k_group, v_group
    del q, k, v, qkv
    result = project_rows(self.out_proj, output, chunks)
    del output
    release_unused_cuda_cache(result)
    return result


attention_forward._uses_optimized_attention = True


class MiniMaxReuseQKVAttention(upstream.MiniMaxLowVRAMAttention):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="MiniMaxReuseQKVAttention",
            display_name="MiniMax H3 QKV Buffer Reuse",
            category="AEONQUILL/experimental",
            description="Inference-only full-sequence attention with consumed Q buffer reuse and chunked token-row projections.",
            is_experimental=True,
            inputs=[
                io.Model.Input("model"),
                io.Int.Input("head_chunks", default=28, min=1, max=56, step=1),
                io.Int.Input("projection_chunks", default=16, min=1, max=64, step=1),
            ],
            outputs=[io.Model.Output(display_name="model")],
        )

    @classmethod
    def execute(cls, model, head_chunks, projection_chunks=16) -> io.NodeOutput:
        if type(head_chunks) is not int or not 1 <= head_chunks <= 56:
            raise ValueError("head_chunks must be an integer in [1, 56]")
        if type(projection_chunks) is not int or not 1 <= projection_chunks <= 64:
            raise ValueError("projection_chunks must be an integer in [1, 64]")
        blocks = getattr(model.get_model_object("diffusion_model"), "blocks", None)
        if not blocks or any(not hasattr(getattr(block, "attn", None), "qkv_proj") for block in blocks):
            raise ValueError("QKV buffer reuse requires a MiniMax H3 diffusion model")
        keys = [f"diffusion_model.blocks.{index}.attn.forward" for index in range(len(blocks))]
        if any(key in model.object_patches for key in keys):
            raise ValueError("QKV buffer reuse cannot replace an existing attention patch")
        patched = super().execute(model, head_chunks)[0]
        options = patched.model_options["transformer_options"]
        options["minimax_head_chunks"] = head_chunks
        options["aeonquill_h3_projection_chunks"] = projection_chunks
        options["sol_take_forward"] = attention_forward
        for key, block in zip(keys, blocks):
            patched.add_object_patch(key, types.MethodType(attention_forward, block.attn))
        return io.NodeOutput(patched)

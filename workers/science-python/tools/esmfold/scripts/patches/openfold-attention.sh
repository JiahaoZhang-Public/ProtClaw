#!/usr/bin/env bash
# Replace CUDA attention kernel with pure PyTorch implementation
set -euo pipefail

SITE_PACKAGES=$(python -c "import site; print(site.getsitepackages()[0])")
cat > "$SITE_PACKAGES/openfold/utils/kernel/attention_core.py" << 'PYEOF'
import torch
import math
def attention_core(q, k, v, bias=None, mask=None):
    scaling = 1.0 / math.sqrt(q.shape[-1])
    a = torch.matmul(q * scaling, k.transpose(-2, -1))
    if bias is not None:
        a = a + bias
    if mask is not None:
        a = a.masked_fill(mask == 0, float("-inf"))
    a = torch.softmax(a, dim=-1)
    return torch.matmul(a, v)
PYEOF

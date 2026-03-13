#!/usr/bin/env bash
# ProtClaw GPUHub Server Setup Script
# Idempotent: safe to re-run after server restart.
#
# Usage: ssh -p 43159 root@connect.singapore-b.gpuhub.com < tools/setup-gpuhub.sh
#
set -euo pipefail

echo "=== ProtClaw GPUHub Setup ==="

# --- Directory layout ---
mkdir -p /root/protclaw/{common,tools,runs}
mkdir -p /root/repos
mkdir -p /root/autodl-tmp/{models/rfdiffusion,models/proteinmpnn,cache/huggingface,envs}

# --- .bashrc environment ---
if ! grep -q "PROTCLAW" /root/.bashrc 2>/dev/null; then
    cat >> /root/.bashrc << 'BASHEOF'

# ProtClaw environment
export PATH="/root/miniconda3/bin:$PATH"
export HF_HOME=/root/autodl-tmp/cache/huggingface
export HUGGINGFACE_HUB_CACHE=/root/autodl-tmp/cache/huggingface
BASHEOF
    echo "  .bashrc updated"
else
    echo "  .bashrc already configured"
fi

source /root/miniconda3/bin/activate

# --- Clone repos (idempotent) ---
if [ ! -d /root/repos/RFdiffusion ]; then
    echo "  Cloning RFdiffusion..."
    cd /root/repos && git clone https://github.com/RosettaCommons/RFdiffusion.git
else
    echo "  RFdiffusion repo exists"
fi

if [ ! -d /root/repos/ProteinMPNN ]; then
    echo "  Cloning ProteinMPNN..."
    cd /root/repos && git clone https://github.com/dauparas/ProteinMPNN.git
else
    echo "  ProteinMPNN repo exists"
fi

if [ ! -d /root/repos/openfold ]; then
    echo "  Cloning openfold..."
    cd /root/repos && git clone https://github.com/aqlaboratory/openfold.git
else
    echo "  openfold repo exists"
fi

# --- Conda envs (idempotent) ---

# CPU env
if [ ! -d /root/autodl-tmp/envs/protclaw-cpu ]; then
    echo "  Creating protclaw-cpu env..."
    conda create -y --prefix /root/autodl-tmp/envs/protclaw-cpu python=3.11
    conda activate /root/autodl-tmp/envs/protclaw-cpu
    pip install biopython scikit-learn numpy openpyxl jinja2 scipy
else
    echo "  protclaw-cpu env exists"
fi

# RFdiffusion env
if [ ! -d /root/autodl-tmp/envs/protclaw-rfdiffusion ]; then
    echo "  Creating protclaw-rfdiffusion env..."
    conda create -y --prefix /root/autodl-tmp/envs/protclaw-rfdiffusion python=3.10
    conda activate /root/autodl-tmp/envs/protclaw-rfdiffusion
    pip install torch --index-url https://download.pytorch.org/whl/cu121
    pip install hydra-core scipy pyrsistent biopython numpy opt_einsum e3nn
    pip install "dgl>=2.0" -f https://data.dgl.ai/wheels/torch-2.1/cu121/repo.html
    cd /root/repos/RFdiffusion && pip install -e .
    cd /root/repos/RFdiffusion/env/SE3Transformer && pip install -e .
else
    echo "  protclaw-rfdiffusion env exists"
fi

# MPNN env
if [ ! -d /root/autodl-tmp/envs/protclaw-mpnn ]; then
    echo "  Creating protclaw-mpnn env..."
    conda create -y --prefix /root/autodl-tmp/envs/protclaw-mpnn python=3.10
    conda activate /root/autodl-tmp/envs/protclaw-mpnn
    pip install torch --index-url https://download.pytorch.org/whl/cu121
    pip install numpy biopython
else
    echo "  protclaw-mpnn env exists"
fi

# ESMFold env
if [ ! -d /root/autodl-tmp/envs/protclaw-esmfold ]; then
    echo "  Creating protclaw-esmfold env..."
    conda create -y --prefix /root/autodl-tmp/envs/protclaw-esmfold python=3.10
    conda activate /root/autodl-tmp/envs/protclaw-esmfold
    pip install torch --index-url https://download.pytorch.org/whl/cu121
    pip install fair-esm biopython numpy omegaconf scipy
    pip install "pytorch-lightning<2.0"
    pip install deepspeed
    pip install "dllogger @ git+https://github.com/NVIDIA/dllogger.git" ml-collections dm-tree modelcif

    # Install openfold from repo with lazy init (avoid CUDA kernel compilation)
    SITE_PACKAGES=$(python -c "import site; print(site.getsitepackages()[0])")
    cp -r /root/repos/openfold/openfold "$SITE_PACKAGES/openfold"
    # Minimal __init__.py to avoid eager imports of CUDA kernels
    echo "# Minimal init - no eager imports" > "$SITE_PACKAGES/openfold/__init__.py"
    echo "# Lazy model imports" > "$SITE_PACKAGES/openfold/model/__init__.py"
    echo "# Lazy utils imports" > "$SITE_PACKAGES/openfold/utils/__init__.py"

    # Patch attention_core.py - replace CUDA kernel with pure PyTorch
    cat > "$SITE_PACKAGES/openfold/utils/kernel/attention_core.py" << 'PYEOF'
import torch
import math

def attention_core(q, k, v, bias=None, mask=None):
    """Pure PyTorch attention (no custom CUDA kernel needed)."""
    scaling = 1.0 / math.sqrt(q.shape[-1])
    a = torch.matmul(q * scaling, k.transpose(-2, -1))
    if bias is not None:
        a = a + bias
    if mask is not None:
        a = a.masked_fill(mask == 0, float("-inf"))
    a = torch.softmax(a, dim=-1)
    return torch.matmul(a, v)
PYEOF

    # Patch structure_module.py - handle missing CUDA kernel
    python -c "
fpath = '$SITE_PACKAGES/openfold/model/structure_module.py'
with open(fpath) as f:
    content = f.read()
content = content.replace(
    'attn_core_inplace_cuda = importlib.import_module(\"attn_core_inplace_cuda\")',
    'try:\n    attn_core_inplace_cuda = importlib.import_module(\"attn_core_inplace_cuda\")\nexcept ModuleNotFoundError:\n    attn_core_inplace_cuda = None'
)
with open(fpath, 'w') as f:
    f.write(content)
"

    # Patch primitives.py - handle missing deepspeed.utils.is_initialized
    python -c "
fpath = '$SITE_PACKAGES/openfold/model/primitives.py'
with open(fpath) as f:
    content = f.read()
content = content.replace(
    'deepspeed.utils.is_initialized()',
    '(hasattr(deepspeed.utils, \"is_initialized\") and deepspeed.utils.is_initialized())'
)
with open(fpath, 'w') as f:
    f.write(content)
"

    # Create torch._six compatibility shim (removed in PyTorch 2.x)
    TORCH_DIR="$SITE_PACKAGES/torch"
    cat > "$TORCH_DIR/_six.py" << 'PYEOF'
"""Compatibility shim for torch._six (removed in PyTorch 2.x)."""
import collections.abc as container_abcs
from math import inf
string_classes = (str,)
int_classes = (int,)
PYEOF

    echo "  ESMFold env created with openfold patches"
else
    echo "  protclaw-esmfold env exists"
fi

# --- Download model weights (idempotent) ---

# RFdiffusion weights
if [ ! -f /root/autodl-tmp/models/rfdiffusion/Base_ckpt.pt ]; then
    echo "  Downloading RFdiffusion weights..."
    cd /root/autodl-tmp/models/rfdiffusion
    wget -q http://files.ipd.uw.edu/pub/RFdiffusion/6f5902ac237024bdd0c176cb93063dc4/Base_ckpt.pt
    wget -q http://files.ipd.uw.edu/pub/RFdiffusion/e29311f6f1bf1af907f9ef9f44b8328b/Complex_base_ckpt.pt
else
    echo "  RFdiffusion weights exist"
fi

# ProteinMPNN weights
if [ ! -f /root/autodl-tmp/models/proteinmpnn/v_48_020.pt ]; then
    echo "  Downloading ProteinMPNN weights..."
    cd /root/autodl-tmp/models/proteinmpnn
    wget -q https://github.com/dauparas/ProteinMPNN/raw/main/vanilla_model_weights/v_48_020.pt
else
    echo "  ProteinMPNN weights exist"
fi

echo "=== Setup complete ==="
echo "Envs: $(ls -d /root/autodl-tmp/envs/protclaw-* 2>/dev/null | wc -l)/4"
echo "Repos: $(ls -d /root/repos/{RFdiffusion,ProteinMPNN,openfold} 2>/dev/null | wc -l)/3"

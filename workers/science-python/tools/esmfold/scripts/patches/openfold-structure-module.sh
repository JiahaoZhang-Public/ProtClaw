#!/usr/bin/env bash
# Handle missing attn_core_inplace_cuda gracefully
set -euo pipefail

SITE_PACKAGES=$(python -c "import site; print(site.getsitepackages()[0])")
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

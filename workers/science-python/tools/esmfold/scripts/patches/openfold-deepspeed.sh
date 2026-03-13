#!/usr/bin/env bash
# Fix deepspeed.utils.is_initialized compatibility
set -euo pipefail

SITE_PACKAGES=$(python -c "import site; print(site.getsitepackages()[0])")
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

#!/usr/bin/env bash
# Create torch._six compatibility shim for PyTorch 2.x
set -euo pipefail

SITE_PACKAGES=$(python -c "import site; print(site.getsitepackages()[0])")
cat > "$SITE_PACKAGES/torch/_six.py" << 'PYEOF'
"""Compatibility shim for torch._six (removed in PyTorch 2.x)."""
import collections.abc as container_abcs
from math import inf
string_classes = (str,)
int_classes = (int,)
PYEOF

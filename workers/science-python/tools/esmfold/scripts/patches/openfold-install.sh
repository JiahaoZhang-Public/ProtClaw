#!/usr/bin/env bash
# Install openfold from repo with lazy init (skip CUDA kernel compilation)
set -euo pipefail

SITE_PACKAGES=$(python -c "import site; print(site.getsitepackages()[0])")
cp -r ${REPOS_DIR}/openfold/openfold "$SITE_PACKAGES/openfold"
echo "# Minimal init - no eager imports" > "$SITE_PACKAGES/openfold/__init__.py"
echo "# Lazy model imports" > "$SITE_PACKAGES/openfold/model/__init__.py"
echo "# Lazy utils imports" > "$SITE_PACKAGES/openfold/utils/__init__.py"

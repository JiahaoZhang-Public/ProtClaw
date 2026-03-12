# Experiment package tool container - CPU only
# Uses the base image for CPU-only tools
FROM protclaw-science-base:latest

WORKDIR /app

# Install experiment-package-specific dependencies
COPY tools/experiment-package/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

# Copy experiment-package adapter
COPY tools/experiment-package/ /app/tools/experiment-package/

ENTRYPOINT ["python", "-m", "common.entrypoint"]

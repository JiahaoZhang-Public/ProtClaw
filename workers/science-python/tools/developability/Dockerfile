# Developability check tool container - CPU only
# Uses the base image for CPU-only tools
FROM protclaw-science-base:latest

WORKDIR /app

# Install developability-specific dependencies
COPY tools/developability/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

# Copy developability adapter
COPY tools/developability/ /app/tools/developability/

ENTRYPOINT ["python", "-m", "common.entrypoint"]

# Candidate operations tool container - CPU only
# Uses the base image for CPU-only tools
FROM protclaw-science-base:latest

WORKDIR /app

# Install candidate-ops-specific dependencies
COPY tools/candidate-ops/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

# Copy candidate-ops adapter
COPY tools/candidate-ops/ /app/tools/candidate-ops/

ENTRYPOINT ["python", "-m", "common.entrypoint"]

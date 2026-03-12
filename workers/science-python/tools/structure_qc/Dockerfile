# Structure QC tool container - CPU only
# Uses the base image for CPU-only tools
FROM protclaw-science-base:latest

WORKDIR /app

# Install structure QC-specific dependencies
COPY tools/structure-qc/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

# Copy structure-qc adapter
COPY tools/structure-qc/ /app/tools/structure-qc/

ENTRYPOINT ["python", "-m", "common.entrypoint"]

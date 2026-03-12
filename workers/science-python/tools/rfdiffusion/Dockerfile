# RFdiffusion tool container - GPU required
FROM nvidia/cuda:11.8.0-runtime-ubuntu22.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.10 python3-pip build-essential git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install PyTorch with CUDA support
RUN pip3 install --no-cache-dir \
    torch==2.0.1+cu118 \
    --extra-index-url https://download.pytorch.org/whl/cu118

# Install common science dependencies
RUN pip3 install --no-cache-dir numpy>=1.24 biopython>=1.81 scipy>=1.11

# Install RFdiffusion-specific dependencies
COPY tools/rfdiffusion/requirements.txt /tmp/requirements.txt
RUN pip3 install --no-cache-dir -r /tmp/requirements.txt

# Copy common worker code
COPY common/ /app/common/

# Copy RFdiffusion adapter
COPY tools/rfdiffusion/ /app/tools/rfdiffusion/

# TODO: Clone and install RFdiffusion
# RUN git clone https://github.com/RosettaCommons/RFdiffusion.git /opt/rfdiffusion
# RUN cd /opt/rfdiffusion && pip3 install -e .

# Set up workspace directories
RUN mkdir -p /workspace/input/files /workspace/output/files

ENTRYPOINT ["python3", "-m", "common.entrypoint"]

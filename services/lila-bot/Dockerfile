FROM python:3.11-slim

# matrix-nio[e2e] needs libolm + build essentials.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libolm-dev \
    libffi-dev \
    libssl-dev \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY pyproject.toml ./
RUN pip install --no-cache-dir .

COPY src ./src

# Encryption store mounted on a Railway volume.
VOLUME ["/data"]
ENV NIO_STORE_PATH=/data/nio-store

CMD ["python", "-m", "src.main"]

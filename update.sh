#!/usr/bin/env bash
# update.sh — stop the running TravelGuide container, pull the latest image
# from GitHub Container Registry, and start a fresh container using .env.
#
# Usage:
#   chmod +x update.sh   # once
#   ./update.sh

set -euo pipefail

IMAGE="ghcr.io/oliverruoff/travelguide:latest"
CONTAINER="travelguide"
PORT="8000"
ENV_FILE="$(cd "$(dirname "$0")" && pwd)/.env"

echo "==> Stopping and removing existing container (if any)..."
docker stop "$CONTAINER" 2>/dev/null || true
docker rm   "$CONTAINER" 2>/dev/null || true

echo "==> Pulling latest image..."
docker pull "$IMAGE"

echo "==> Starting new container..."
docker run -d \
  --name "$CONTAINER" \
  --restart unless-stopped \
  -p "${PORT}:8000" \
  --env-file "$ENV_FILE" \
  "$IMAGE"

echo ""
echo "✓ TravelGuide is running at http://localhost:${PORT}"
echo "  Logs: docker logs -f ${CONTAINER}"

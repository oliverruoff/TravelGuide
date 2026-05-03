# ── Stage 1: build the React frontend ────────────────────────────────────────
FROM node:22-alpine AS frontend-builder

WORKDIR /app/frontend

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --silent

COPY frontend/ ./
RUN npm run build


# ── Stage 2: Python backend + compiled frontend ───────────────────────────────
FROM python:3.13-slim AS runtime

WORKDIR /app

# Install Python dependencies
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy backend source and prompt templates
COPY backend/ ./backend/
COPY prompts/ ./prompts/

# Copy compiled frontend from Stage 1
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist

# Run uvicorn — serve on 0.0.0.0 so Docker can expose the port
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]

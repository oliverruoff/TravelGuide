# TravelGuide GenAI

A modern, intelligent travel guide PWA that uses AI to discover and curate personalized points of interest (POIs) for any destination. Search for a location, and the app uses AI to find nearby landmarks, attractions, and hidden gems—then generates detailed, engaging guides with smooth text streaming animations and save-to-collection features.

## Features

- **AI-Powered POI Discovery**: Search any location and get AI-curated points of interest with semantic ranking
- **Smart Status Messages**: Real-time, user-friendly feedback (e.g., "Found 80 interesting spots nearby. Researching now...")
- **Streaming Text Animation**: Character-by-character animated text with variable delays and intelligent punctuation handling for a polished, engaging experience
- **Save to Collection**: Save favorite POIs with smooth animation (card shrinks and fades to top-right corner)
- **Text-to-Speech**: Listen to guide details with native browser TTS
- **Responsive Design**: Fully responsive UI with elegant card layouts and micro-interactions
- **Progressive Web App**: Works offline-first with IndexedDB for saved POIs
- **Interactive Map**: Integrated MapLibre GL for location visualization
- **Single Container Deployment**: Frontend and backend served from one lightweight Docker image

## Project Structure

```
TravelGuide/
├── Dockerfile                          # Two-stage Docker build: Node (frontend) + Python (backend)
├── docker-compose.yml                  # Docker Compose configuration with env_file support
├── .github/
│   └── workflows/
│       └── docker-publish.yml          # GitHub Actions CI/CD for GHCR
├── frontend/                           # React 19 + Vite + TypeScript
│   ├── src/
│   │   ├── App.tsx                     # Main app with DetailCard, SavedDrawer, streaming animations
│   │   ├── api.ts                      # API client with SSE streaming support
│   │   └── styles.css                  # Animations: typing cursor, save card, spacing
│   ├── vite.config.ts
│   ├── package.json
│   └── dist/                           # Compiled static files (copied to Docker image)
├── backend/                            # Python FastAPI
│   ├── main.py                         # FastAPI app, static file serving, SPA routing, SSE streaming
│   ├── settings.py                     # Configuration management
│   ├── models.py                       # Pydantic models (POI, etc.)
│   └── services.py                     # Business logic (select_pois, enrich_poi, stream_detail)
├── prompts/                            # LLM prompt templates
│   ├── poi_select_system.txt           # POI selection system prompt
│   ├── poi_select_user.txt             # POI selection user prompt
│   ├── poi_enrich_system.txt           # POI enrichment system prompt
│   ├── poi_enrich_user.txt             # POI enrichment user prompt
│   ├── detail_stream_system.txt        # Detail streaming system prompt
│   ├── detail_stream_user.txt          # Detail streaming user prompt
│   ├── detail_completion_system.txt    # Detail completion system prompt
│   └── detail_completion_user.txt      # Detail completion user prompt
├── requirements.txt                    # Python dependencies
├── .env                                # Environment variables (API keys, config)
└── .gitignore
```

## Tech Stack

### Frontend
- **React 19** with TypeScript
- **Vite** for fast bundling
- **Framer Motion** for smooth animations
- **MapLibre GL** for maps
- **Zustand** for state management
- **Dexie** for IndexedDB (PWA storage)
- **Lucide React** for icons

### Backend
- **Python 3.13** (slim Docker image)
- **FastAPI** for REST API
- **Uvicorn** ASGI server
- **Pydantic** for data validation
- **httpx** for HTTP requests

## Environment Setup

### Requirements
- Docker & Docker Compose (recommended)
- OR Node.js 22+ and Python 3.13+ for local development

### Environment Variables

Create a `.env` file in the project root with your API keys:

```bash
# Required for AI functionality
MINIMAX_API_KEY=your_minimax_key
BRAVE_API_KEY=your_brave_api_key

# Optional: other configs
LOG_LEVEL=info
```

## Deployment

### Option 1: Docker Compose (Recommended)

**Build and run locally:**

```bash
docker-compose up --build
```

The app will be available at `http://localhost:8000`.

**For production:**
- Set environment variables in `.env` file
- Deploy the `docker-compose.yml` to your server
- Update the port mapping as needed

### Option 2: Standalone Docker Image

**Build the image:**

```bash
docker build -t travelguide:latest .
```

**Run the container:**

```bash
docker run -p 8000:8000 \
  --env-file .env \
  travelguide:latest
```

### Option 3: GitHub Container Registry (GHCR)

This project includes GitHub Actions CI/CD that automatically builds and pushes Docker images to GHCR on every push to the `main` branch.

**Pull and run the latest image:**

```bash
docker run -p 8000:8000 \
  --env-file .env \
  ghcr.io/oliverruoff/travelguide:latest
```

**To enable automatic builds:**
1. Ensure the repository is public or grant appropriate permissions
2. GitHub Actions will build and push on every `main` branch push
3. Images are tagged as `ghcr.io/oliverruoff/travelguide:latest`

### Option 4: Local Development

**Setup frontend:**

```bash
cd frontend
npm install
npm run dev
```

Frontend will be available at `http://127.0.0.1:5173` (with proxy to backend).

**Setup backend:**

```bash
python -m venv venv
source venv/bin/activate  # or venv\Scripts\activate on Windows
pip install -r requirements.txt
uvicorn backend.main:app --reload
```

Backend will be available at `http://127.0.0.1:8000`.

## How It Works

### 1. Search for a Location
- User enters a location (e.g., "Paris")
- Frontend sends a request to the backend API

### 2. AI Discovers POIs
- Backend uses Brave Search to find nearby locations
- AI (MiniMax) ranks and curates the most interesting POIs
- User sees a friendly status message like "Found 80 interesting spots nearby. Researching now..."

### 3. View and Save POIs
- POI list displays with cards showing name, category, and distance
- Click a POI to open the detail card
- Save button triggers a smooth animation (card shrinks to top-right and fades out)
- Heart icon opens Saved POIs drawer with saved items

### 4. Read Detail Guide
- Detail card streams guide text character-by-character with variable delays
- Blinking cursor appears during streaming
- Listen button provides text-to-speech
- Guide button in Saved POIs drawer opens the detail card

### 5. Offline Support
- Saved POIs are stored in IndexedDB
- App works offline for previously viewed content
- Data syncs when connection is restored

## API Endpoints

### Search POIs
```
POST /api/search
Content-Type: application/json

{
  "query": "Paris"
}
```

Response:
```json
{
  "pois": [
    {
      "id": "...",
      "name": "Eiffel Tower",
      "category": "Landmark",
      "distance": 0.5,
      "latitude": 48.858,
      "longitude": 2.294
    },
    ...
  ]
}
```

### Stream Detail Guide
```
GET /api/detail/{poi_id}
```

Returns a Server-Sent Event (SSE) stream with guide text chunks.

## Docker Image Details

- **Base Image**: python:3.13-slim (runtime), node:22-alpine (build)
- **Size**: ~60 MB (multi-stage build optimization)
- **Port**: 8000
- **Features**:
  - Two-stage build: Node builds React, Python runs backend
  - Static file serving for React SPA
  - Catch-all route for client-side routing
  - Environment variable support via `.env` file

## Performance

- **Build Time**: ~40 seconds (with caching)
- **Container Startup**: ~2 seconds
- **First Paint**: <1 second
- **Text Streaming**: 20-100ms per character (variable delays)

## Testing

Run backend tests:

```bash
pytest tests/
```

Run frontend tests:

```bash
cd frontend && npm test
```

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/amazing-feature`
3. Commit your changes: `git commit -m 'Add amazing feature'`
4. Push to the branch: `git push origin feature/amazing-feature`
5. Open a Pull Request

## License

MIT

## Support

For issues, questions, or feedback, please open an issue on GitHub.

---

**Built with ❤️ for travelers and explorers everywhere.**

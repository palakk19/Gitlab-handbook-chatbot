# Deployment Guide

## Render

1. Push this folder to GitHub.
2. Create a new Render Web Service from the repository.
3. Render can read `render.yaml`, or you can set:
   - Build command: `npm install`
   - Start command: `npm run start`
4. Add one optional environment variable:
   - `OPENAI_API_KEY` for OpenAI-generated final wording, or
   - `GEMINI_API_KEY` for Gemini-generated final wording.

The app works without either key in retrieval mode.

## Railway or Fly.io

Use Node 18+ and the same start command:

```bash
npm run start
```

The server reads `PORT` from the host environment.

## Local Production Check

```bash
npm test
npm run eval
PORT=3001 npm run start
```

Open `http://127.0.0.1:3001`.

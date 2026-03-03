# VoixLà - Architecture Spec

**Project**: Voice transcription app with Gemini Flash AI
**Stack**: Next.js 15 (App Router), React 19, TypeScript, PWA
**Env**: `GEMINI_API_KEY` (required)

## File Structure

| Path | Purpose |
|------|---------|
| `app/page.tsx` | Entry point (client component), renders VoiceRecorder |
| `app/components/VoiceRecorder.tsx` | Main UI component (audio recording, history, editing, cost display) |
| `app/api/transcribe/route.ts` | POST endpoint - transcribes audio, auto-fallback Flash if quota hit |
| `app/layout.tsx` | Root layout, PWA metadata, i18n:fr |
| `app/globals.css` | Global styles |
| `app/page.module.css` | Page/component styles |
| `next.config.js` | Next.js config |
| `public/manifest.json` | PWA manifest |
| `public/icon-*.png` | App icons (192x192, 512x512, maskable variants) |

## Services/Features

### VoiceRecorder Component
- Real-time audio recording (MediaRecorder API)
- Automatic transcription with Gemini Flash
- Real-time cost calculation
- LocalStorage history (id, timestamp, content, model, cost, preview)
- Edit transcript & retry transcription
- Download transcript as file
- Copy to clipboard

### Transcribe Endpoint (`/api/transcribe`)
- Accepts: audio file (FormData) + optional existingText
- Uses Gemini Flash for all transcriptions
- Retry logic: 503/overloaded/timeout errors retry after 3s
- Timeout: 10min per request, 50MB max file
- Two prompt modes:
  1. **New**: Brief oral input → formatted text
  2. **Edit mode**: Existing text + verbal instructions → modified text
- Response: `{success, content, cost: {totalEUR, totalUSD, inputTokens, outputTokens, model}, timestamp}`

### PWA
- Icons & manifest in public/
- Metadata configured in layout.tsx

## Key Technical Details

- **Model**: gemini-3-flash-preview
- **Pricing** (2026): Flash $1/$3 per 1M tokens
- **Cost calc**: (promptTokens × price_input + outputTokens × price_output) / 1M, USD→EUR ×0.92
- **Language**: French UI
- **History**: Stored in localStorage (client-side only, max 100 chars preview)
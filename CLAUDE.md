# Claude Code Instructions

**START HERE**: Read `SPEC.md` first on every new session to understand the project architecture, files, and services.

**UPDATE**: When making architectural changes (new files, routes, services, or major refactors), update `SPEC.md` to keep it accurate and minimal.

---

## Quick Context
- **VoixLà**: Next.js 15 voice transcription app powered by Gemini AI
- **Main entry**: `app/page.tsx` → `app/components/VoiceRecorder.tsx`
- **API**: `app/api/transcribe/route.ts` (POST, auto-fallback Flash, cost calculation)
- **Config**: Requires `GEMINI_API_KEY` env var
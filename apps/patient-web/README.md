# Patient portal

Independent Vue portal served at `/patient/`; development listens on `127.0.0.1:5174` and proxies `/api` to `127.0.0.1:3200`.

The follow-up screen accepts only microphone audio. Account, password and contact forms allow typing. Cookies identify the patient and CSRF tokens remain in module memory. No credentials or transcripts use browser persistent storage.

Voice capture uses AudioWorklet, mono PCM16 WAV at 16 kHz, adaptive speech detection, 850 ms trailing silence and a 24-second limit. Capture is disabled during assistant playback. Manual sentence completion, playback interruption/replay, pause/resume and hangup are available. Backgrounding pauses and requires an explicit resume.

Server mode downloads standard WAV from the authenticated API and plays it through Web Audio, unlocked synchronously by the start/resume gesture. SpeechSynthesis is not required in this mode. Browser mode remains optional and requires an installed simplified Chinese voice. Playback failure or timeout requires explicit retry. Microphone capture still requires a secure context and AudioWorklet support. No SpeechRecognition API is used.

An in-flight upload retains its original bytes, request key and version for an explicit idempotent retry. A saved turn found on refresh is recovered without re-uploading. No-speech and invalid-audio responses allow a new recording. Hangup waits for the upload and never submits an empty call. Pending operations after a page reload require an explicit recovery action.

Verification from the repository root:

```powershell
node --import tsx --test apps/patient-web/test/*.test.ts
npx vue-tsc --noEmit -p apps/patient-web/tsconfig.json
npm run build --workspace @heart/patient-web
# Run the development server before the UI-only synthetic smoke test:
node --import tsx apps/patient-web/test/browser-smoke.ts
```

The smoke test defaults to installed Microsoft Edge and uses synthetic API/speech boundaries plus the browser's fake microphone. Screenshots are saved in ignored `.qa/`. This is not a human microphone, real speech output or mobile device acceptance test. Actual iOS/Android, WeChat browser, audio route changes, real network switching and natural speech latency require device testing.

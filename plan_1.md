# Phase 1 Implementation Plan: Voice Guide MVP

Date: 2026-04-07
Repo: `ScreenAI`
Goal: add a first usable voice workflow to ScreenAI so a user can ask a spoken question about the current screen and receive both spoken guidance and an on-screen guide panel.

## 1. What Phase 1 Is Trying To Prove

Phase 1 is not trying to build a full desktop agent.

Phase 1 is trying to prove three things:

1. Voice input is materially faster and more natural than typing for "what do I do here?" questions.
2. ScreenAI can answer those questions with enough speed and clarity that users will use it repeatedly.
3. The product can guide the user safely without taking over their mouse or clicking the wrong thing.

If Phase 1 works, it gives us a stable base for later cursor guidance, real mouse movement, and app-specific desktop automation.

## 2. Motivation

### Product motivation

The current app already solves "capture a region and type a question." That is useful, but it still asks the user to stop, select, and type.

The proposed voice workflow removes most of that friction:

- the user keeps focus in the target app
- the user asks naturally in speech
- the system answers in speech and visually
- the user does not need to switch context or type

This is a much stronger product direction than "chat about screenshots" alone.

### Technical motivation

This repo already has the right foundations:

- global hotkeys in `main/hotkey.js`
- screen capture in `main/screenshot.js`
- Electron window orchestration in `main/main.js`
- a secure preload IPC bridge in `preload/preload.js`
- multimodal LLM requests in `main/llm.js`

That means Phase 1 is an extension of the current architecture, not a new system.

## 3. Why Phase 1 Must Stay Narrow

Phase 1 intentionally does not include:

- real OS mouse movement
- auto-clicking
- full desktop automation
- continuous always-listening mode
- multi-monitor support
- active-window capture
- barge-in while TTS is speaking
- persistent realtime STT sessions

### Why

Each of those features adds a new class of risk:

- mouse movement and clicks create safety and trust problems
- always-listening creates privacy, echo, and lifecycle problems
- persistent STT adds transport complexity and failure modes
- multi-monitor and active-window capture add platform-specific edge cases

The right first milestone is: "Can the user press one hotkey, speak a question, and get useful spoken plus visual guidance?"

## 4. Core Product Decision For Phase 1

Phase 1 will be a `toggle-to-talk` flow, not `hold-to-talk`.

### Why

The current hotkey system uses Electron `globalShortcut`. That API is good for global triggers, but it is not the right primitive for key-down plus key-up push-to-talk behavior.

So for Phase 1:

1. Press voice hotkey once to start listening.
2. Speak.
3. Press the same hotkey again to stop and submit.

This is the smallest reliable desktop interaction model that fits the current app.

## 5. STT Transport Decision For Laptop / Electron

This is the most important architecture choice in Phase 1.

### Decision

For ScreenAI on desktop, Phase 1 will use:

- local microphone capture in an Electron renderer
- IPC to send the completed recording to the Electron main process
- one-shot ElevenLabs STT in the main process

Phase 1 will not use:

- a local app WebSocket between renderer and backend
- a persistent ElevenLabs realtime STT WebSocket
- browser-side ElevenLabs tokens

### Why this is the right choice

In your `discord_voice_agent` repo, the transport layer is harder because the audio source and the AI backend are separate systems:

- browser mode needs `browser -> app websocket -> STT service`
- Discord mode needs a persistent STT socket because audio is continuous and packetized

ScreenAI is different:

- microphone capture and application logic already live in the same Electron app
- the user explicitly starts and stops each utterance
- we do not need partial transcripts in Phase 1
- we do not need barge-in in Phase 1

That means a much simpler path is available.

### Exact Phase 1 STT shape

1. Renderer captures mic audio with `getUserMedia`.
2. Renderer records a bounded utterance with `MediaRecorder`.
3. Renderer sends the final audio bytes plus MIME type to the main process over IPC.
4. Main uploads that recording to ElevenLabs batch speech-to-text.
5. Main receives plain transcript text and continues the pipeline.

### Why this is better than realtime STT for Phase 1

- fewer moving parts
- simpler debugging
- no keepalive logic
- no silence transport gate
- no reconnect logic
- no client-side secret exposure
- no partial transcript state machine
- lower implementation risk

### API choice

Use ElevenLabs batch speech-to-text via `POST /v1/speech-to-text` with `model_id=scribe_v2`.

Why batch instead of realtime:

- the user explicitly ends the utterance
- Phase 1 needs final transcript quality, not live partials
- the recorder can send WebM/Opus directly
- it fits the product interaction much better than a streaming session

## 6. Target Phase 1 User Experience

### Happy path

1. User focuses a software window on the primary display.
2. User presses the voice hotkey.
3. A small voice HUD appears showing `Listening`.
4. User says something like: `How do I turn off notifications here?`
5. User presses the hotkey again.
6. The HUD changes to `Thinking`.
7. ScreenAI captures the current primary screen.
8. ScreenAI transcribes the speech with ElevenLabs.
9. ScreenAI sends `screenshot + transcript` to the LLM.
10. A guide window opens with:
    - short summary
    - 1 to 3 steps
    - optional highlight box on the screenshot
11. ScreenAI speaks a short answer aloud.
12. User can close the guide or replay the spoken answer.

### Example output

Spoken:

`Open Settings from the top right, then select Notifications. I highlighted the gear icon.`

Visual:

- summary line
- numbered steps
- screenshot preview with one highlighted region

## 7. What We Are Building In Phase 1

## 7.1 New app mode: Voice Guide

We will add a second hotkey-driven workflow beside the existing screenshot-plus-chat flow.

Existing flow:

- hotkey
- manual region select
- typed question
- streaming answer

New Phase 1 flow:

- voice hotkey
- mic record
- full-screen capture
- STT
- structured guidance
- spoken answer

This should be implemented as a distinct path, not by forcing the existing chat overlay to do everything.

## 7.2 New voice session state machine

Add an explicit voice session state in the main process.

Recommended states:

- `idle`
- `recording`
- `transcribing`
- `capturing`
- `analyzing`
- `showing_result`
- `speaking`
- `error`

### Why

Without explicit state, hotkey handling becomes ambiguous and bugs appear quickly:

- pressing the hotkey during STT
- closing the HUD while recording
- recording twice
- starting screenshot flow while voice flow is active

The state machine should live in the main process because main already owns hotkeys, windows, capture, and API orchestration.

## 7.3 Voice HUD window

Add a small dedicated renderer window for voice state.

Purpose:

- show `Listening`, `Thinking`, `Speaking`, `Error`
- display a simple waveform or level meter if time permits
- give the user confidence that the hotkey worked

This should be a small frameless always-on-top window, not a full panel.

### Why a separate HUD

- the current overlay is designed for screenshot chat, not recording state
- recording needs immediate visual confirmation
- a small HUD can stay visible without blocking the app being examined

## 7.4 Microphone capture in renderer

Microphone capture should happen in a renderer window, not in the main process.

### Why

Electron renderers already have access to Chromium media APIs:

- `navigator.mediaDevices.getUserMedia`
- `MediaRecorder`
- Web Audio if needed later

This is the easiest and most standard place to request mic permission and record audio.

### Phase 1 recording approach

Use `MediaRecorder` to record a bounded utterance.

Preferred format:

- `audio/webm;codecs=opus` if supported
- otherwise browser default `audio/webm`

### Why `MediaRecorder`

- simplest implementation
- no custom PCM encoder required
- no resampling code needed
- ElevenLabs batch STT accepts common audio formats
- enough quality for this product stage

### Recorder stop conditions

Phase 1 stop conditions:

- second voice hotkey press
- explicit cancel action
- max duration timeout, for example 20 seconds

Optional later inside Phase 1 polish:

- silence-based auto-stop after user speech ends

This should not block the first implementation.

## 7.5 Screen capture strategy

Phase 1 should capture the full primary display after recording stops.

### Why capture after recording

- the user may navigate or point during speech
- we want the screenshot to reflect the final screen state tied to the question

### Why full primary display in Phase 1

- current code already captures the primary display
- it avoids new active-window and multi-monitor work
- it keeps the voice flow frictionless

### Known limitation

This is less precise than active-window capture and may reduce grounding quality on cluttered screens. That is acceptable in Phase 1 and should be called out as a known limit.

## 7.6 Structured LLM guide response

Do not use the current streaming free-text chat response path for voice guidance.

Add a separate LLM method that returns a complete structured object.

### Why

Voice guidance needs predictable fields:

- short spoken summary
- ordered steps
- optional target box
- confidence

That is harder to enforce with an open-ended streaming text response.

### Recommended response schema

```json
{
  "transcript": "How do I turn off notifications here?",
  "spoken_summary": "Open Settings and choose Notifications. I highlighted the gear icon.",
  "summary": "Use the top-right Settings menu, then open Notifications.",
  "steps": [
    {
      "id": 1,
      "title": "Open settings",
      "instruction": "Click the gear icon in the top right corner.",
      "target": { "x": 0.88, "y": 0.06, "w": 0.08, "h": 0.08 },
      "confidence": 0.86
    },
    {
      "id": 2,
      "title": "Open notifications",
      "instruction": "Select Notifications from the settings panel.",
      "target": null,
      "confidence": 0.71
    }
  ],
  "overall_confidence": 0.79,
  "needs_user_confirmation": false
}
```

### Important output rules

- coordinates must be normalized `0..1` relative to the screenshot
- maximum 3 steps
- spoken summary must be short
- if uncertain, the model must say so
- no invented precision if the target is ambiguous

## 7.7 Guide result window

Add a dedicated guide renderer for Phase 1 result presentation.

Suggested content:

- transcript text
- short summary
- 1 to 3 steps
- screenshot preview
- one highlight box if present
- `Replay audio` button
- `Close` button

### Why a dedicated guide renderer

The existing overlay is chat-first. Voice guide is answer-first.

Keeping voice guide in a separate renderer avoids overloading the current chat UI with:

- recording states
- transcript display
- structured steps
- spoken replay controls

## 7.8 TTS playback

Add a new `main/tts.js` module for ElevenLabs text-to-speech.

### TTS scope in Phase 1

Speak only:

- the short spoken summary
- optionally the first step if it fits naturally

Do not read the entire guide aloud.

### Why

- spoken output must be short and useful
- long spoken instructions are frustrating
- the screen already shows the detailed steps

### Playback design

1. Main process requests TTS audio from ElevenLabs.
2. Main sends the returned audio bytes to the renderer over IPC.
3. Renderer creates a Blob URL and plays it with standard web audio playback.

If TTS fails, the guide window should still open and remain fully usable.

## 8. Implementation Workstreams

## 8.1 Settings and configuration

### What we will add

New settings fields:

- `elevenlabsApiKey`
- `voiceHotkey`
- `voiceEnabled`
- `voiceId`
- `preferredSttLanguage` optional
- `maxVoiceDurationMs`

### Files

- `main/settings.js`
- `renderer/settings.html`
- `renderer/settings.js`
- `renderer/settings.css`

### Why

Phase 1 introduces a new provider and a new interaction mode. Those settings must be user-configurable and persist alongside the existing model and hotkey settings.

## 8.2 Hotkey registration

### What we will add

Add a second hotkey path for voice guide mode.

Suggested default:

- Windows: `F8`
- macOS: `Shift+Command+V`

Make it configurable in settings.

### Files

- `main/hotkey.js`
- `main/main.js`

### Why

The screenshot flow and the voice guide flow are different actions. They should not compete for the same trigger.

## 8.3 Voice session orchestration in main

### What we will add

Add a new orchestrator path in `main/main.js`:

- start voice session
- open HUD
- request recording start
- stop recording
- receive audio
- call STT
- capture screen
- call LLM guide method
- open guide window
- call TTS
- cleanup

### Why

This keeps voice mode consistent with the current architecture, where main owns privileged actions and window lifecycle.

## 8.4 New preload IPC surface

### What we will add

New IPC channels for voice mode.

Suggested channels:

- `voice:start-recording`
- `voice:stop-recording`
- `voice:cancel`
- `voice:audio-ready`
- `voice:state`
- `guide:init`
- `guide:play-audio`
- `guide:error`

### Files

- `preload/preload.js`

### Why

The renderer must not directly access secrets or arbitrary Electron APIs. The current preload pattern is correct and should be extended, not bypassed.

## 8.5 Microphone HUD renderer

### What we will build

Create:

- `renderer/voice-hud.html`
- `renderer/voice-hud.js`
- `renderer/voice-hud.css`

Responsibilities:

- request microphone access
- start and stop `MediaRecorder`
- collect audio chunks
- send final audio to main
- display voice state from main

### Why

This keeps mic capture isolated from the rest of the UI and avoids coupling it to the screenshot chat overlay.

## 8.6 STT module

### What we will build

Create `main/stt.js`.

Responsibilities:

- accept `Buffer` plus MIME type
- build multipart request
- call ElevenLabs speech-to-text
- return normalized transcript object

Suggested normalized result:

```js
{
  text: "...",
  languageCode: "en",
  durationMs: 3400
}
```

### Recommended dependency

Add `form-data` for multipart POSTs if needed.

### Why

STT logic should not be embedded in `main/main.js`. It deserves its own module just like screenshot and LLM integration.

## 8.7 LLM guide method

### What we will build

Extend `main/llm.js` with a separate method, for example:

- `getVoiceGuide(imageBuffer, transcript)`

Responsibilities:

- send screenshot and transcript to the selected model
- request strict structured output
- validate returned JSON
- normalize missing or invalid fields

### Why

This is a different product contract than chat streaming. It should be modeled explicitly in code.

## 8.8 Guide renderer

### What we will build

Create:

- `renderer/guide.html`
- `renderer/guide.js`
- `renderer/guide.css`

Responsibilities:

- show transcript
- render summary and steps
- draw normalized highlight box on screenshot preview
- replay spoken answer
- close cleanly

### Why

The guide result has a clear, static information shape. A purpose-built renderer will be simpler and more maintainable than retrofitting the chat window.

## 8.9 TTS module

### What we will build

Create `main/tts.js`.

Responsibilities:

- call ElevenLabs TTS API
- request a standard output format such as MP3
- return audio bytes and MIME type

Suggested result:

```js
{
  mimeType: "audio/mpeg",
  audioBuffer: Buffer
}
```

### Why

Like STT, TTS is privileged provider logic and should remain in the main process.

## 8.10 Logging and diagnostics

### What we will add

Add structured log points for:

- hotkey pressed
- mic recording started
- mic recording stopped
- recording duration
- STT start and end
- capture start and end
- LLM start and end
- TTS start and end
- transcript text
- overall voice flow duration

### Why

Voice pipelines fail in many places. Without logs, debugging feels random.

## 9. File-Level Change List

Expected file changes:

- `main/main.js`
- `main/hotkey.js`
- `main/settings.js`
- `main/llm.js`
- `preload/preload.js`
- `renderer/settings.html`
- `renderer/settings.js`
- `renderer/settings.css`

New files:

- `main/stt.js`
- `main/tts.js`
- `renderer/voice-hud.html`
- `renderer/voice-hud.js`
- `renderer/voice-hud.css`
- `renderer/guide.html`
- `renderer/guide.js`
- `renderer/guide.css`

Possible package changes:

- `package.json`
- `package-lock.json`

## 10. Recommended Build Order

Implement in this order:

### Step 1: settings and hotkey plumbing

- add ElevenLabs settings
- add voice hotkey
- wire a placeholder voice flow

Success condition:

- pressing the voice hotkey opens and closes a dummy HUD reliably

### Step 2: microphone recording

- request mic permission
- record audio in HUD renderer
- return audio bytes to main

Success condition:

- the app records a valid audio blob and reports its duration

### Step 3: one-shot STT

- implement `main/stt.js`
- upload recorded audio to ElevenLabs
- print transcript to logs

Success condition:

- spoken questions reliably produce transcript text

### Step 4: screen capture plus guide LLM

- capture primary screen when recording ends
- implement `getVoiceGuide()`
- validate structured result

Success condition:

- app produces a summary and steps from `screenshot + transcript`

### Step 5: guide window

- build guide renderer
- show transcript, summary, steps, screenshot, highlight

Success condition:

- the full guide is visually usable even if TTS is disabled

### Step 6: TTS playback

- implement `main/tts.js`
- send audio bytes to guide renderer
- add replay control

Success condition:

- the app speaks the summary after guide generation

### Step 7: polish and hardening

- error handling
- cancellation paths
- timeouts
- cleanup bugs
- logging

Success condition:

- the app recovers cleanly from common failure cases

## 11. Error Handling Plan

Phase 1 must explicitly handle:

- microphone permission denied
- no ElevenLabs API key configured
- empty recording
- empty transcript
- STT timeout or API error
- screen capture failure
- LLM invalid JSON
- TTS failure
- user presses hotkey during in-flight analysis
- user closes HUD or guide window mid-flow

### Recovery rules

- if STT fails: show error and stop
- if LLM fails: show transcript and fallback error
- if TTS fails: still show guide window
- if guide window closes: stop playback and clean state

## 12. Security and Privacy Rules

Phase 1 should follow these rules:

- keep ElevenLabs API key in the main process only
- do not call ElevenLabs directly from the renderer
- send only bounded audio blobs over IPC
- do not keep recordings on disk by default
- do not keep transcripts unless logging is explicitly desired
- clear in-memory audio buffers after use

### Why

Voice data is more sensitive than typed prompts. Even in a local app, the default behavior should be minimal retention.

## 13. Known Limitations In Phase 1

- only primary-display capture
- full-screen capture instead of active-window capture
- no real mouse movement
- no click execution
- no live partial transcript
- no follow-up voice conversation loop
- no barge-in during spoken response
- no guaranteed precise target coordinates from the model

These are acceptable if the core guide experience is good.

## 14. Acceptance Criteria

Phase 1 is done when all of the following are true:

1. User can configure an ElevenLabs API key and a voice hotkey.
2. Pressing the voice hotkey starts recording and shows clear visual feedback.
3. Pressing the hotkey again stops recording and submits the utterance.
4. The app transcribes speech through ElevenLabs and logs the transcript.
5. The app captures the current primary screen after recording stops.
6. The app generates a structured guide from the screenshot and transcript.
7. The guide window shows:
   - transcript
   - summary
   - numbered steps
   - screenshot preview
   - optional highlight
8. The app speaks a short answer aloud.
9. If TTS fails, the visual guide still works.
10. The app returns to `idle` cleanly after success, close, cancel, or error.

## 15. Manual Test Matrix

Minimum manual tests:

- valid short question
- valid long question
- no speech, only noise
- microphone permission denied
- missing ElevenLabs key
- STT network failure
- screenshot capture failure
- LLM malformed output
- TTS failure
- repeated start-stop cycles
- pressing screenshot hotkey during voice flow
- pressing voice hotkey during screenshot flow

## 16. Phase 1 Success Metric

The practical success metric for Phase 1 is:

`A user can ask a spoken software-navigation question and receive a useful spoken plus visual answer in one uninterrupted flow, without typing or manually selecting a region.`

If that feels good in real use, then Phase 2 can safely add:

- active-window capture
- better grounding
- hotspot stepping
- ghost cursor
- optional real mouse movement

## 17. Summary Of Why This Plan Is Correct

This plan is correct for Phase 1 because it matches the current codebase and avoids the expensive parts too early.

It deliberately reuses what the repo already does well:

- Electron main-process orchestration
- screenshot capture
- secure IPC
- multimodal LLM calls

And it deliberately avoids what would slow the project down:

- persistent audio transport
- browser-backend-style streaming architecture
- native desktop automation
- risky cursor execution

The result is a voice guide MVP that is useful, technically realistic, and directly extensible into later phases.

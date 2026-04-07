# ScreenAI Voice Pipeline — Latency Report

Analyze the ScreenAI voice pipeline latency from the terminal log in this conversation.

## What to do

1. Find all `[PERF]` tagged lines from the most recent voice pipeline run in the conversation
2. If no log is in context, ask the user to paste the terminal output
3. Extract each stage duration and produce the report below

---

## Pipeline stages to extract

| Log pattern | Stage | What it measures |
|---|---|---|
| `[PERF] hud-load: Xms` | HUD Load | Hotkey press → HUD window JS ready |
| `[PERF] recording-duration: Xms` | Recording | Mic open → stop pressed (user speech) |
| `[PERF] stt: Xms` | STT | ElevenLabs speech-to-text API round-trip |
| `[PERF] capture: Xms` | Capture | Full-screen PNG capture |
| `[PERF] llm: Xms` | LLM | Gemini multimodal analysis round-trip |
| `[PERF] guide-open: Xms` | Guide Open | Guide window initialization |
| `[PERF] tts: Xms` | TTS | ElevenLabs text-to-speech API round-trip |
| `[PERF] pipeline-summary ...` | Summary line | All stages in one line |
| `[PERF] wall-clock: Xms` | Wall Clock | Hotkey press → audio playing |

---

## Report format

Produce the report in exactly this structure:

---

### ScreenAI Voice Pipeline — Latency Report

**Pipeline total** (stt + capture + llm + guide-open): `Xms`
**Wall-clock total** (hotkey → audio playing): `Xms`

#### Stage Breakdown

| Stage | Duration | % of Pipeline | Flag |
|---|---|---|---|
| HUD Load | Xms | — | |
| Recording (user speech) | Xms | — | not a bottleneck |
| STT — ElevenLabs | Xms | X% | |
| Screen Capture | Xms | X% | |
| LLM — Gemini | Xms | X% | |
| Guide Window Open | Xms | X% | |
| TTS — ElevenLabs | Xms | X% | |

> Flag ⚠️ any stage that is > 5000ms or > 60% of pipeline total.

#### Bottleneck

State clearly which single stage is the biggest bottleneck and what % of the pipeline it takes.

#### Optimization Opportunities

For each stage that is a significant portion of the pipeline, give one specific, actionable suggestion:

- **LLM** (usually the largest): Try a faster model (`gemini-2.0-flash` vs preview), reduce screenshot resolution before sending, shorten the system prompt
- **STT**: Reduce recording duration (shorter questions), check audio file size, try a faster ElevenLabs STT model
- **TTS**: Shorten `spoken_summary` (currently capped at 50 words — check if it's close), cache common phrases, try `eleven_flash_v2_5` model
- **Capture**: Screenshot is PNG — consider JPEG at 80% quality to reduce bytes sent to LLM
- **HUD Load**: Consider keeping a hidden preloaded HUD window to eliminate cold-start load time

#### Multi-Run Comparison (if multiple runs are present in the log)

| Stage | Run 1 | Run 2 | Run 3 | Avg | Best |
|---|---|---|---|---|---|
| STT | | | | | |
| Capture | | | | | |
| LLM | | | | | |
| TTS | | | | | |
| Wall-clock | | | | | |

---

## Additional notes

- `recording-duration` is user behaviour, not a system bottleneck — do not include it in pipeline %
- TTS runs **async** after the guide window opens, so `pipeline-summary subtotal` does not include TTS
- `wall-clock` includes TTS and is the true end-to-end user-perceived latency
- If a stage is missing from the log, mark it as `—` and note it may not have been instrumented yet

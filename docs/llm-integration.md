# LLM Integration — Gemini Vision API

## 1. Why Gemini

Gemini Flash is Google's fastest multimodal model, optimised for high-frequency, latency-sensitive tasks like real-time screen analysis. It accepts both images and text in a single request and returns a structured JSON response.

| Model | Speed | Vision | Best for |
|---|---|---|---|
| `gemini-2.0-flash` | Very fast | ✓ | Screen analysis, real-time queries |
| `gemini-1.5-pro` | Moderate | ✓ | Complex reasoning, long documents |
| `gemini-1.0-pro` | Fast | ✗ | Text-only tasks |

## 2. API endpoint

```
POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={apiKey}
```

## 3. Request format

The `contents` array accepts interleaved image and text `parts`:

```json
{
  "contents": [
    {
      "parts": [
        {
          "inline_data": {
            "mime_type": "image/png",
            "data": "<base64-encoded-png>"
          }
        },
        {
          "text": "What error is shown in this screenshot?"
        }
      ]
    }
  ],
  "generationConfig": {
    "temperature": 0.4,
    "maxOutputTokens": 2048
  }
}
```

**Image ordering**: Place the image part *before* the text part so the model has visual context when it reads the question.

## 4. Response format

```json
{
  "candidates": [
    {
      "content": {
        "parts": [
          { "text": "The error shown is a NullPointerException..." }
        ],
        "role": "model"
      },
      "finishReason": "STOP"
    }
  ],
  "usageMetadata": {
    "promptTokenCount": 512,
    "candidatesTokenCount": 120
  }
}
```

Extract text:
```js
const text = data.candidates[0].content.parts.map(p => p.text || '').join('');
```

## 5. Implementation (llm.js)

```js
const fetch  = require('node-fetch'); // v2 (CommonJS)
const config = require('./config');

async function askLLM(imageBuffer, prompt) {
  const url  = `https://generativelanguage.googleapis.com/v1beta/models/` +
               `${config.geminiModel}:generateContent?key=${config.geminiApiKey}`;

  const body = {
    contents: [{
      parts: [
        { inline_data: { mime_type: 'image/png', data: imageBuffer.toString('base64') } },
        { text: prompt },
      ],
    }],
    generationConfig: { temperature: 0.4, maxOutputTokens: 2048 },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);

  const data = await res.json();
  return data.candidates[0].content.parts.map(p => p.text || '').join('');
}
```

## 6. Safety settings

By default Gemini blocks content that might be "dangerous". For developer tools that analyse code, error messages, and terminal output, these filters can block legitimate responses. We relax them to `BLOCK_ONLY_HIGH`:

```json
"safetySettings": [
  { "category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_ONLY_HIGH" }
]
```

## 7. Temperature and token tuning

| Setting | Value | Reasoning |
|---|---|---|
| `temperature` | 0.4 | Low randomness for factual screen analysis |
| `maxOutputTokens` | 2048 | Enough for detailed code explanations |

For creative tasks (e.g., "suggest improvements"), raise temperature to 0.7–0.9.

## 8. Error handling

| HTTP status | Meaning | Recovery |
|---|---|---|
| 400 | Bad request (invalid image, empty prompt) | Show error to user |
| 403 | Invalid API key or quota exceeded | Prompt user to check key |
| 429 | Rate limit | Back off and retry (Phase 2) |
| 500 | Server error | Retry once, then show error |

## 9. Image size limits

Gemini accepts images up to **20 MB** as inline data. A full 4K screenshot PNG is typically 3–8 MB. After cropping to the selected region, it's usually under 1 MB.

For large selections, consider resizing with Jimp before sending:

```js
// Resize if width > 1920px (keeps it under API limits)
if (image.getWidth() > 1920) {
  image.scaleToFit(1920, Jimp.AUTO);
}
```

## 10. Prompt engineering for screen analysis

Effective prompts for screen content:

| Goal | Prompt style |
|---|---|
| Error analysis | "What is the error shown? What is the most likely cause?" |
| Code review | "Review this code snippet. List any bugs or improvements." |
| UI feedback | "Describe the UI elements visible. Are there any usability issues?" |
| Data extraction | "Extract all text visible in the screenshot into a structured list." |

The system can prepend a system context message in Phase 2:
```json
{ "role": "user", "parts": [{ "text": "You are a developer assistant analysing screen content..." }] }
```

## 11. node-fetch v2 vs v3

- **v2**: CommonJS `require('node-fetch')` — works in standard Electron (CommonJS)
- **v3**: ESM only — requires `"type": "module"` in package.json, incompatible with standard Electron main process

This project uses **v2** (`"node-fetch": "2.7.0"`).

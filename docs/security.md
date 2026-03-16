# Security Considerations

## 1. Electron security model

Electron apps have more attack surface than web apps because they run Node.js alongside the browser. A vulnerability in a renderer page can escalate to full OS access if the app is misconfigured.

### Key settings enforced in this project

| Setting | Value | Why |
|---|---|---|
| `nodeIntegration` | `false` | Renderer cannot `require()` Node modules |
| `contextIsolation` | `true` | Renderer runs in an isolated V8 context |
| `webSecurity` | (default `true`) | Same-origin policy enforced |
| Content-Security-Policy | Strict | Blocks inline scripts and remote resources |
| Only local pages loaded | `loadFile()` | Never `loadURL()` with user-supplied URLs |

## 2. IPC channel hardening

Only specific, named channels are exposed through `contextBridge`. Raw `ipcRenderer` is never passed to the renderer.

```js
// ✓ Correct — named channels only
contextBridge.exposeInMainWorld('electronAPI', {
  sendAsk: (prompt) => ipcRenderer.send('overlay:ask', { prompt }),
});

// ✗ Never do this — exposes all IPC
contextBridge.exposeInMainWorld('ipc', ipcRenderer);
```

### Input validation in main process

The main process validates IPC payloads before acting on them:

```js
ipcMain.on('overlay:ask', (event, { prompt }) => {
  if (typeof prompt !== 'string' || prompt.trim().length === 0) return;
  // ...
});
```

## 3. API key management

The Gemini API key is a secret credential. Rules:

- **Never** commit the `.env` file (`.gitignore` covers it).
- **Never** send the API key to the renderer process.
- **Never** include the key in client-side JavaScript.
- The key lives in `process.env` in the main process only.
- `llm.js` is main-process code; the renderer never sees the key.

```js
// All API calls happen in main — renderer never touches the key
ipcMain.on('overlay:ask', async (event, { prompt }) => {
  const text = await askLLM(croppedBuffer, prompt); // key used here, in main
  event.sender.send('overlay:response', { text });
});
```

For packaged distributions, consider:
- Storing the key in the OS keychain (`keytar` package).
- Prompting the user for their key on first run and storing it securely.
- Using a backend proxy that holds the key server-side (Phase 2+).

## 4. Content Security Policy

Every HTML file includes a strict CSP meta tag:

```html
<meta http-equiv="Content-Security-Policy"
      content="default-src 'self';
               script-src 'self';
               style-src 'self' 'unsafe-inline';
               img-src 'self' data:;" />
```

This blocks:
- Remote scripts (XSS via compromised CDN)
- `eval()` and `new Function()`
- Remote stylesheets
- Remote images (only local + data URIs allowed)

`'unsafe-inline'` is allowed for styles only, not scripts. Inline styles are needed for `backdrop-filter` browser resets.

## 5. Screenshot data handling

Screenshots may contain sensitive information (passwords, private messages, code). Rules:

- Screenshots are held in-memory only (`Buffer`) — never written to disk.
- Buffers are explicitly nulled after the overlay closes (`croppedBuffer = null`).
- Data is transmitted to Gemini's API over HTTPS only.
- No analytics, logging, or caching of screenshot data.

```js
function closeAll() {
  // ...
  fullScreenBuffer = null;  // GC the large buffer
  croppedBuffer    = null;
}
```

## 6. XSS prevention in the overlay

The AI response text is rendered using a custom formatter that:
1. **Escapes HTML entities** before inserting into the DOM.
2. Then wraps backtick spans in `<code>` tags via regex substitution.

```js
function formatResponse(text) {
  // Escape first — prevents injected HTML from Gemini's response
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Safe to apply code formatting after escaping
  return escaped.replace(/`([^`]+)`/g, '<code>$1</code>');
}
```

**Never** do `element.innerHTML = apiResponse` without sanitisation.

## 7. Process isolation summary

```
Renderer (capture.html)
  ↓ only sends: { x, y, width, height }  (numbers)
Main process
  ↓ only calls: jimp.crop()

Renderer (overlay.html)
  ↓ only sends: { prompt }  (string, max validated length)
Main process
  ↓ only calls: askLLM()
  ↓ only returns: { text }  (string, sanitised before DOM injection)
Renderer
```

Each boundary transmits only the minimal typed payload. No file paths, no shell commands, no Node.js objects cross the IPC boundary.

## 8. Future hardening checklist

- [ ] Store API key in OS keychain (keytar)
- [ ] Add rate limiting on the `overlay:ask` IPC channel
- [ ] Add maximum prompt length validation
- [ ] Consider a Content-Security-Policy `nonce` for even stricter CSP
- [ ] Code-sign the app (required for macOS Gatekeeper and Windows SmartScreen)
- [ ] Notarise the macOS build (required for distribution without "Unknown developer" warning)

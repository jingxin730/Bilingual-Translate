# Bilingual Translate

[简体中文](README.md) | English

A Chrome extension that uses AI to provide bilingual side-by-side translation — the original text stays in place and the translation appears directly below each paragraph. Also supports real-time bilingual subtitle translation on YouTube.

## Features

**Web Page Translation**
- Original text stays in place, with each translation directly below its paragraph
- Four AI backends: Claude, ChatGPT, Gemini, DeepSeek
- Target languages: Simplified Chinese, Traditional Chinese, Japanese, English
- Batched concurrent translation with real-time progress
- Stop mid-way and keep already-translated paragraphs
- Toggle translation visibility or clear all with one click
- Keyboard shortcut `Alt+A` to trigger translation
- Automatically skips navigation bars, footers, and other non-content areas
- Translation color inherits from the original text — readable on both dark and light backgrounds
- Translations follow the original reading column and adapt to centered, flex, and grid layouts
- News-card headlines and summaries are translated separately
- After starting page translation, automatically translates newly expanded comments, replies, and loaded content, including WSJ OpenWeb comments in Shadow DOM

**YouTube Subtitle Translation**
- Adds an icon button to the player's bottom-right control bar
- One click to enable bilingual subtitles: original and translated text overlaid on the same frame
- Automatically identify and translate YouTube subtitle data.
- Download original-only or bilingual subtitles as SRT or Markdown (.md)
- Original-only downloads skip AI translation for quick reading or AI summaries; bilingual downloads reuse playback sentences, timing, and cached translations
- In-session caching: scrubbing back to a watched position shows cached translations instantly
- Auto-resets on SPA video navigation, reuses model settings
- Uses the same AI model and target language as web page translation

## Installation

**1. Clone or download this repository**

```bash
git clone https://github.com/jingxin730/Bilingual-Translate.git
cd Bilingual-Translate
```

**2. Configure your API credentials**

```bash
cp config.example.js config.js
```

Open `config.js` in your editor and set your API token, endpoint URLs, and model names:

```js
const API_TOKEN = 'your-api-token-here';

const PROVIDERS = {
  chatgpt: {
    url: 'https://your-endpoint/codex/v1/chat/completions',
    model: 'gpt-4o',
    type: 'openai'
  },
  // ...
};
```

Each provider may also carry its own `token` (falling back to the global `API_TOKEN`), and anything in `extraBody` is merged verbatim into the request body for vendor-specific parameters. That's how the official DeepSeek API is wired up:

```js
const DEEPSEEK_API_KEY = 'your-deepseek-api-key';   // platform.deepseek.com/api_keys

deepseek: {
  url: 'https://api.deepseek.com',
  model: 'deepseek-flash',        // or deepseek-v4-pro
  type: 'openai',
  token: DEEPSEEK_API_KEY,
  extraBody: { thinking: { type: 'disabled' } }   // thinking is on by default; translation doesn't need it
}
```

> ⚠️ **Note**: There are many ways to access large language models (self-hosted, proxies, official APIs, etc.). The configuration above is just one example format. If it doesn't match your setup, paste the contents of `config.example.js` and `background.js` into an AI tool (e.g. Claude or ChatGPT), describe your API format, and ask it to adapt the configuration for you.

**3. Load the extension in Chrome**

- Open `chrome://extensions/`
- Enable **Developer mode** in the top-right corner
- Click **Load unpacked** and select the project folder

## Usage

**Web Page Translation**

1. Open any foreign-language web page
2. Click the extension icon in the toolbar, or press `Alt+A`
3. Choose a target language and AI provider, then click **Translate**
4. Translations appear below each paragraph, inheriting the original text color
5. Expand comments or replies, or load more content: new text is translated using the same model and target language. Expanding the full text of an existing comment also updates its translation

Automatic translation starts only after you manually translate the page. Stopping or clearing translation disables it. Newly translated content stays hidden while translation visibility is off.

| Action | Description |
|--------|-------------|
| Hide / Show | Temporarily hide all translations without removing them |
| Clear | Remove all translations and restore the original page |
| Stop | Interrupt an in-progress translation, keeping paragraphs already done |

**YouTube Subtitle Translation**

1. Open any YouTube video with available captions
2. Click the icon button in the player controls (next to the gear icon)
3. Confirm the AI model in the panel and click **Start translating subtitles**
4. Bilingual subtitles appear at the bottom of the video — original on top, translation below

The panel groups **Playback subtitles** and **Download subtitles** separately. In the download section, choose **Original only** or **Original + translation**, then **SRT (.srt)** or **Markdown (.md)** and click the download button. Original-only exports do not request or wait for AI translations and work with available captions even without a configured translation model. Bilingual exports place the original above its translation. Markdown includes the video title, video link, and timestamp links for easy reading and note taking. Downloads independently read the current player track and fetch complete captions, including on a fresh or paused page without playback translation. If needed, the download loads the native caption module itself. Original-only downloads never request translation; bilingual downloads reuse the current model/language cache and translate unwatched sections, showing progress while preparing. When only live DOM captions are available, the download collects them independently without playback translation; the button and filename identify recorded coverage only, with `watched` in the filename. Rate limits and timeouts are reported directly so the request can be retried later. Changing the video cancels preparation; changing the model or target language also cancels bilingual downloads. Content and format are locked while preparing. The panel scrolls in small windows. Missing translations are retried in smaller groups for up to two recovery rounds while successful items stay cached. If recovery fails, download again to continue from the missing items.

## File Structure

```
├── _locales/
│   ├── en/messages.json      # English strings
│   └── zh_CN/messages.json   # Chinese strings
├── icons/
│   ├── icon16.png            # Extension icon 16×16
│   ├── icon48.png            # Extension icon 48×48
│   └── icon128.png           # Extension icon 128×128
├── manifest.json             # Extension config (Manifest V3)
├── background.js             # Service Worker — calls translation APIs
├── content.js                # Injected into pages — finds translatable elements and inserts translations
├── content.css               # Translation styles (border, text color, loading animation)
├── popup.html                # Popup panel HTML
├── popup.js                  # Popup panel logic
├── popup.css                 # Popup panel styles
├── youtube-bridge.js         # MAIN world script — intercepts subtitle data and bridges to isolated world
├── youtube.js                # YouTube subtitle translation core logic
├── youtube.css               # YouTube subtitle overlay and button styles
├── config.js                 # Local config (API token + endpoints) — excluded from Git via .gitignore
└── config.example.js         # Config template committed to the repo for reference
```

## Development checks

With Node.js installed, run the regression tests from the project root:

```bash
node --test tests/*.test.js
```

## Notes

- `config.js` is excluded via `.gitignore` and will not be pushed to Git — do not commit it manually
- You must create `config.js` before the extension will work
- YouTube subtitle translation requires a video with available caption tracks (auto-generated captions are supported)

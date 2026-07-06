# Bilingual Translate

A Chrome extension that uses AI to provide bilingual side-by-side translation — the original text stays in place and the translation appears directly below each paragraph. Also supports real-time bilingual subtitle translation on YouTube.

## Features

**Web Page Translation**
- Original and translated text displayed side by side for a natural reading experience
- Three AI backends: Claude, ChatGPT, Gemini
- Target languages: Simplified Chinese, Traditional Chinese, Japanese, English
- Batched concurrent translation with real-time progress
- Stop mid-way and keep already-translated paragraphs
- Toggle translation visibility or clear all with one click
- Keyboard shortcut `Alt+A` to trigger translation
- Automatically skips navigation bars, footers, and other non-content areas
- Translation color inherits from the original text — readable on both dark and light backgrounds

**YouTube Subtitle Translation**
- Adds an icon button to the player's bottom-right control bar
- One click to enable bilingual subtitles: original and translated text overlaid on the same frame
- Automatically identify and translate YouTube subtitle data.
- In-session caching: scrubbing back to a watched position shows cached translations instantly
- Auto-resets on SPA video navigation, reuses model settings
- Uses the same AI model and target language as web page translation

## Installation

**1. Clone or download this repository**

```bash
git clone https://github.com/jingxin730/Bilingual-Translate.git
cd bilingual-translate
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
    url: 'https://your-endpoint',
    model: 'gpt-5.5',
    type: 'openai'
  },
  // ...
};
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

## Notes

- `config.js` is excluded via `.gitignore` and will not be pushed to Git — do not commit it manually
- You must create `config.js` before the extension will work
- YouTube subtitle translation requires a video with available caption tracks (auto-generated captions are supported)

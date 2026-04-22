// 复制此文件为 config.js，填入你自己的配置
// cp config.example.js config.js
const API_TOKEN = 'your-api-token-here';

const PROVIDERS = {
  claude: {
    url: 'https://your-endpoint/claude/v1/chat/completions',
    model: 'claude-sonnet-4-6',
    type: 'openai'
  },
  chatgpt: {
    url: 'https://your-endpoint/codex/v1/chat/completions',
    model: 'gpt-4o',
    type: 'openai'
  },
  gemini: {
    url: 'https://your-endpoint/gemini/v1beta/models/gemini-pro:generateContent',
    model: 'gemini-pro',
    type: 'gemini'
  }
};

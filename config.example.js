// 复制此文件为 config.js，填入你自己的配置
// cp config.example.js config.js

// 默认 Token：provider 没单独配 token 时用这个
const API_TOKEN = 'your-api-token-here';

// DeepSeek 官方 API Key，在 https://platform.deepseek.com/api_keys 创建
const DEEPSEEK_API_KEY = 'your-deepseek-api-key';

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
  },
  // DeepSeek 官方 API（OpenAI 兼容格式）。token 单独配，不走上面的 API_TOKEN。
  // extraBody 会原样合并进请求体；thinking 默认 enabled，翻译不需要思维链，关掉更快更省。
  deepseek: {
    url: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    type: 'openai',
    token: DEEPSEEK_API_KEY,
    extraBody: { thinking: { type: 'disabled' } }
  },
  'deepseek-pro': {
    url: 'https://api.deepseek.com',
    model: 'deepseek-v4-pro',
    type: 'openai',
    token: DEEPSEEK_API_KEY,
    extraBody: { thinking: { type: 'disabled' } }
  }
};

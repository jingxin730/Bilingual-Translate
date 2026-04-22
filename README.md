# 双语翻译

Chrome 扩展，使用 AI 对网页进行双语对照翻译——原文保留在原位，中文译文紧跟在每个段落下方。

## 功能特点

- 原文与译文并排显示，阅读体验自然
- 支持三种 AI 服务：Claude、ChatGPT、Gemini
- 可选目标语言：简体中文、繁体中文、日文、英文
- 分批并发翻译，进度实时显示
- 支持中途停止，已翻译内容保留
- 一键隐藏 / 显示译文、清除全部译文
- 快捷键 `Alt+A` 触发翻译
- 自动识别并跳过导航栏、页脚等非正文区域
- 深色模式自适应

## 安装

1. 克隆或下载本仓库

```bash
git clone https://github.com/你的用户名/bilingual-translate.git
cd bilingual-translate
```

2. 复制配置文件模板并填入你的 API 信息

```bash
cp config.example.js config.js
```

用编辑器打开 `config.js`，填入你的 API Token 以及各服务的接口地址和模型名称：

```js
const API_TOKEN = 'your-api-token-here';

const PROVIDERS = {
  claude: {
    url: 'https://your-endpoint/claude/v1/chat/completions',
    model: 'claude-sonnet-4-6',
    type: 'openai'
  },
  // ...
};
```

3. 在 Chrome 中加载扩展

   - 打开 `chrome://extensions/`
   - 右上角开启「开发者模式」
   - 点击「加载已解压的扩展程序」，选择本项目文件夹

## 使用方法

1. 打开任意英文（或其他外语）网页
2. 点击浏览器工具栏中的扩展图标，或按 `Alt+A`
3. 选择目标语言和翻译服务，点击「翻译」
4. 译文会以灰色小字显示在每段原文下方

**快捷操作**

| 操作 | 说明 |
|------|------|
| 隐藏译文 / 显示译文 | 临时隐藏所有译文，不删除 |
| 清除翻译 | 移除所有译文，恢复原始页面 |
| 停止翻译 | 中断进行中的翻译，保留已翻译段落 |

## 文件结构

```
├── manifest.json       # 扩展配置（MV3）
├── background.js       # Service Worker，负责调用翻译 API
├── content.js          # 注入页面，识别可翻译元素并插入译文
├── content.css         # 译文样式（边框、字色、loading 动画）
├── popup.html          # 弹出面板 HTML
├── popup.js            # 弹出面板逻辑
├── popup.css           # 弹出面板样式
├── config.js           # 本地配置（API Token + 接口地址），已被 .gitignore 忽略
└── config.example.js   # 配置模板，提交到 Git 供参考
```

## 注意事项

- `config.js` 已被 `.gitignore` 排除，不会上传到 Git，请勿手动提交
- 克隆仓库后必须先创建 `config.js`，否则扩展无法运行

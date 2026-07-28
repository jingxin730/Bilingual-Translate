# 双语翻译

Chrome 扩展，使用 AI 对网页进行双语对照翻译——原文保留在原位，译文紧跟在每个段落下方。同时支持 YouTube 视频双语字幕实时翻译。

## 功能特点

**网页翻译**
- 原文与译文并排显示，阅读体验自然
- 支持三种 AI 服务：Claude、ChatGPT、Gemini
- 可选目标语言：简体中文、繁体中文、日文、英文
- 分批并发翻译，进度实时显示
- 支持中途停止，已翻译内容保留
- 一键隐藏 / 显示译文、清除全部译文
- 快捷键 `Alt+A` 触发翻译
- 自动识别并跳过导航栏、页脚等非正文区域
- 译文颜色自动继承原文，深色 / 浅色背景均清晰可读

**YouTube 字幕翻译**
- 在播放器右下控制栏新增图标按钮
- 一键开启双语字幕：原文（英文）与译文同帧叠加显示
- 自动识别 YouTube 字幕数据并翻译
- 视频内缓存，拖动进度条回跳无需重新翻译
- SPA 切换视频后自动清场，复用设置
- 使用与网页翻译相同的 AI 模型和目标语言

## 安装

**1. 克隆或下载本仓库**

```bash
git clone https://github.com/jingxin730/Bilingual-Translate.git
cd bilingual-translate
```

**2. 配置 API 信息**

```bash
cp config.example.js config.js
```

用编辑器打开 `config.js`，填入你的 API Token 以及各服务的接口地址和模型名称：

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

> ⚠️ **注意**：接入大模型的方式有很多种（自有部署、各类代理、官方 API 等），上述配置仅为参考示例。如果此格式不适用于你的大模型接口，建议将 `config.example.js` 和 `background.js` 的内容提供给 AI 工具（如 Claude、ChatGPT），说明你的接口格式，让它帮你重新适配配置。

**3. 在 Chrome 中加载扩展**

- 打开 `chrome://extensions/`
- 右上角开启「开发者模式」
- 点击「加载已解压的扩展程序」，选择本项目文件夹

## 使用方法

**网页翻译**

1. 打开任意英文（或其他外语）网页
2. 点击浏览器工具栏中的扩展图标，或按 `Alt+A`
3. 选择目标语言和翻译服务，点击「翻译」
4. 译文会跟随原文颜色显示在每段原文下方

| 操作 | 说明 |
|------|------|
| 隐藏译文 / 显示译文 | 临时隐藏所有译文，不删除 |
| 清除翻译 | 移除所有译文，恢复原始页面 |
| 停止翻译 | 中断进行中的翻译，保留已翻译段落 |

**YouTube 字幕翻译**

1. 打开任意带字幕的 YouTube 视频
2. 点击播放器右下控制栏（齿轮旁）的图标按钮
3. 在面板的选择框中确认或切换 AI 模型，点击「开始翻译字幕」
4. 视频画面下方将实时显示双语字幕（原文在上，译文在下）

## 文件结构

```
├── _locales/
│   ├── en/messages.json      # 英文文案
│   └── zh_CN/messages.json   # 中文文案
├── icons/
│   ├── icon16.png            # 扩展图标 16×16
│   ├── icon48.png            # 扩展图标 48×48
│   └── icon128.png           # 扩展图标 128×128
├── manifest.json             # 扩展配置（MV3）
├── background.js             # Service Worker，负责调用翻译 API
├── content.js                # 注入页面，识别可翻译元素并插入译文
├── content.css               # 译文样式（边框、字色、loading 动画）
├── popup.html                # 弹出面板 HTML
├── popup.js                  # 弹出面板逻辑
├── popup.css                 # 弹出面板样式
├── youtube-bridge.js         # MAIN world 脚本：拦截字幕数据并桥接给隔离环境
├── youtube.js                # YouTube 字幕翻译核心逻辑
├── youtube.css               # YouTube 字幕层及按钮样式
├── config.js                 # 本地配置（API Token + 接口地址），已被 .gitignore 忽略
└── config.example.js         # 配置模板，提交到 Git 供参考
```

## 注意事项

- `config.js` 已被 `.gitignore` 排除，不会上传到 Git，请勿手动提交
- 克隆仓库后必须先创建 `config.js`，否则扩展无法运行
- YouTube 字幕功能需要视频有可用字幕轨道（自动生成字幕也支持）

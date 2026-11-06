# 双语翻译

简体中文 | [English](README_EN.md)

Chrome 扩展，使用 AI 对网页进行双语对照翻译——原文保留在原位，译文紧跟在每个段落下方。同时支持 YouTube 视频双语字幕实时翻译。

## 功能特点

**网页翻译**
- 保留原文，译文显示在对应段落下方，方便对照阅读
- 支持四种 AI 服务：Claude、ChatGPT、Gemini、DeepSeek
- 可选目标语言：简体中文、繁体中文、日文、英文
- 分批并发翻译，进度实时显示
- 支持中途停止，已翻译内容保留
- 一键隐藏 / 显示译文、清除全部译文
- 快捷键 `Alt+A` 触发翻译
- 自动识别并跳过导航栏、页脚等非正文区域
- 译文颜色自动继承原文，深色 / 浅色背景均清晰可读
- 译文跟随原文阅读栏，适配居中段落、Flex 和 Grid 布局
- 新闻卡片的标题与摘要分别翻译
- 开启网页翻译后，自动补译随后展开的评论、回复和加载更多内容，支持 WSJ OpenWeb 的 Shadow DOM 评论组件

**YouTube 字幕翻译**
- 在播放器右下控制栏新增图标按钮
- 一键开启双语字幕：原文与译文同帧叠加显示
- 自动识别 YouTube 字幕数据并翻译
- 支持下载「仅原文」或「原文 + 译文」，均可选择 SRT 或 Markdown（.md）
- 仅原文下载不调用 AI 翻译，适合交给 AI 总结视频；双语下载复用实时字幕的分句、时间和译文缓存
- 视频内缓存，拖动进度条回跳无需重新翻译
- SPA 切换视频后自动清场，复用设置
- 使用与网页翻译相同的 AI 模型和目标语言

## 安装

**1. 克隆或下载本仓库**

```bash
git clone https://github.com/jingxin730/Bilingual-Translate.git
cd Bilingual-Translate
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
    url: 'https://your-endpoint/codex/v1/chat/completions',
    model: 'gpt-4o',
    type: 'openai'
  },
  // ...
};
```

每个 provider 也可以带自己的 `token`（不配则用全局 `API_TOKEN`），另外 `extraBody` 里的字段会原样合并进请求体，用来传各家的私有参数。DeepSeek 官方 API 就是这么接的：

```js
const DEEPSEEK_API_KEY = 'your-deepseek-api-key';   // platform.deepseek.com/api_keys

deepseek: {
  url: 'https://api.deepseek.com',
  model: 'deepseek-flash',        // 或 deepseek-v4-pro
  type: 'openai',
  token: DEEPSEEK_API_KEY,
  extraBody: { thinking: { type: 'disabled' } }   // 思考模式默认开启，翻译用不上
}
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
5. 随后展开评论、回复或点击加载更多，插件会沿用本次的模型和目标语言自动补译，无需重新翻译整篇文章；展开同一条评论的全文时也会更新译文

自动补译只在手动开启本页翻译后生效，停止翻译或清除翻译会关闭监听。隐藏译文期间，新内容的译文也保持隐藏。

| 操作 | 说明 |
|------|------|
| 隐藏译文 / 显示译文 | 临时隐藏所有译文，不删除 |
| 清除翻译 | 移除所有译文，恢复原始页面 |
| 停止翻译 | 中断进行中的翻译，保留已翻译段落 |

**YouTube 字幕翻译**

1. 打开带字幕的 YouTube 视频，点击播放器控制栏（齿轮旁）的图标按钮
2. 面板分为「观看时的字幕」与「下载字幕」两组
3. 如需边看边翻译，在「观看时的字幕」中选择 AI 模型，点击「开始翻译字幕」；原文在上、译文在下
4. 如需下载，在「下载字幕」中选择内容与文件格式，再点击下载按钮：
   - **仅原文**：导出视频的原始语言字幕，不调用 AI 翻译、不等待译文，适合用于 AI 总结和提炼视频重点
   - **原文 + 译文**：导出双语字幕，复用当前模型和目标语言的译文缓存，并补译尚未播放的部分
   - **SRT（.srt）**：保留时间轴，可用于支持 SRT 的播放器
   - **Markdown（.md）**：包含视频标题、视频链接及可点击的时间段，便于阅读、复制和整理笔记

下载会独立读取当前视频的字幕轨道，未开启观看翻译、尚未播放或暂停时也会主动获取完整字幕，无需先点击「开始翻译字幕」。如果字幕模块尚未加载，下载流程会自行加载并等待。仅原文下载不会调用翻译模型。下载准备期间会锁定内容和格式选择，避免导出设置混用；面板在小窗口下可滚动使用。

若无法取得完整轨道，下载流程仍会独立收集可见的 YouTube 原生 DOM 字幕，按钮和文件会注明「已观看」，只包含已记录部分，文件名带 `watched`，无需开启观看翻译。YouTube 限流或请求超时时会显示具体原因，可稍后重试。切换视频会取消本次下载；双语下载也会随模型或目标语言切换而取消。模型漏译时会保留成功项，只对缺失字幕自动缩小批次补译，最多补译两轮；仍失败时可再次下载，已有译文会继续复用。

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
├── youtube-bridge.js         # MAIN world 脚本：拦截字幕，按需读取当前轨道并获取字幕
├── youtube.js                # YouTube 字幕翻译核心逻辑
├── youtube.css               # YouTube 字幕层及按钮样式
├── config.js                 # 本地配置（API Token + 接口地址），已被 .gitignore 忽略
└── config.example.js         # 配置模板，提交到 Git 供参考
```

## 开发检查

安装 Node.js 后，在项目根目录运行回归测试：

```bash
node --test tests/*.test.js
```

## 注意事项

- `config.js` 已被 `.gitignore` 排除，不会上传到 Git，请勿手动提交
- 克隆仓库后必须先创建 `config.js`，否则扩展无法运行
- YouTube 字幕功能需要视频有可用字幕轨道（自动生成字幕也支持）

# Webpage Content Reader MCP

一个基于 Playwright 的网页内容解析 MCP Server，用于完整读取网页文本、图片元素、样式信息、DOM 层级和响应式布局，并输出结构化 JSON 与可交互 HTML 预览页。

## 功能

- 文本解析：采集标题、段落、列表、表格、引用、代码块及链接，并保留粗体、斜体、下划线、超链接等内联格式信息。
- 图片处理：识别 `<img>`、背景图、SVG、视频 poster，记录 URL、尺寸、坐标、alt、title、caption、父级布局关系，并支持本地缓存。
- 结构化存储：输出 `meta`、`text`、`images`、`layouts`、`styles`、`output`，保留 DOM 路径、层级、视觉位置和计算样式。
- 预览能力：生成 `preview.html`，支持缩放、滚动、按 block id 或文本定位元素。
- 动态页面支持：使用无头 Chromium 渲染，支持 AJAX 内容、懒加载滚动触发和多个响应式断点采集。

## 安装

```bash
npm install
npx playwright install chromium
npm run build
```

## MCP 配置

构建后将以下配置加入 MCP 客户端：

```json
{
  "mcpServers": {
    "webpage-content-reader": {
      "command": "node",
      "args": ["/Users/bytedance/Documents/trae_projects/zhinengkefu/dist/server.js"]
    }
  }
}
```

### MCP 市场上传

如果市场提示 zip 中缺少 `mcpServers` 字段，请上传仓库根目录的 `mcp.json`，或重新下载包含该文件的 GitHub zip。

```json
{
  "mcpServers": {
    "webpage-to-larkdoc": {
      "command": "npx",
      "args": [
        "-y",
        "git+https://github.com/bob0602/webpagetolarkdoc-mcp.git"
      ]
    }
  }
}
```

## MCP 工具

### `extract_webpage_content`

完整解析网页并生成输出文件。

参数：

- `url`：必填，目标网页 URL。
- `outputDir`：可选，输出目录；默认 `output/<runId>`。
- `viewport`：主视口，默认 `{ "width": 1280, "height": 800 }`。
- `breakpoints`：响应式断点，默认 `[360, 768, 1024, 1280]`。
- `includeStyles`：是否采集计算样式，默认 `true`。
- `includeHtml`：是否保存原始 HTML 片段，默认 `true`。
- `includeDynamicContent`：是否滚动触发懒加载和 AJAX 内容，默认 `true`。
- `cacheImages`：是否缓存图片到本地，默认 `true`。
- `waitUntil`：页面加载等待策略，默认 `networkidle`。
- `timeoutMs`：超时时间，默认 `45000`。
- `maxDepth`：DOM 树快照最大深度，默认 `20`。
- `userAgent`：可选自定义 User-Agent。

返回摘要包含标题、最终 URL、文本长度、块数量、图片数量、断点和输出路径。

### `describe_output_schema`

返回输出 JSON 的顶层结构说明。

### `sync_webpage_to_lark_doc`

解析网页并同步到飞书云文档。处理流程：

- 先解析网页，生成 `webpage.json`、`preview.html`、`lark-content.xml` / `lark-content.md`。
- 仅在传入 `docUrl` / `docToken` 时校验并更新已有文档。
- 未传文档 URL/Token 时始终创建新文档，不再按标题搜索同名文档。
- 文档存在时默认 `overwrite`，即清空原文档内容后写入新内容。
- 内容超过限制时分块写入，正文默认优先使用飞书 XML 以保留标题、段落、列表和分栏图片结构。
- 普通图片按原文位置写入 XML 图片块；GIF 图片启用特殊处理模式：先写占位符，再用 `docs +media-insert` 上传本地 `.gif`，移动到占位位置后删除占位符，避免 GIF 被转成静态 JPEG。
- 每次搜索、创建、更新、重试和失败都会写入 `lark-sync.jsonl`。

核心参数：

- `larkTarget.title`：目标文档标题，未传 `docUrl/docToken` 时用于创建新文档。
- `larkTarget.docUrl` / `larkTarget.docToken`：直接指定要清空并覆盖写入的已有文档。
- `larkTarget.folderToken`：创建新文档所在云空间文件夹。
- `larkTarget.wikiNode` / `larkTarget.wikiSpace`：创建到知识库节点或空间。
- `updateMode`：默认 `overwrite` 全量覆盖；可显式设为 `append` 增量追加。
- `identity`：`user` 或 `bot`，默认 `user`。
- `maxChunkChars`：内容过大时的分块大小，默认 `14000`。
- `uploadImages`：默认 `true`。XML 模式下普通图片保留原位外链写入，GIF 自动走保真上传并原位移动；设为 `false` 时 GIF 会降级为普通外链图片。
- `retries`：网络异常或频率限制重试次数，默认 `3`。

## CLI 使用

```bash
npm run extract -- https://example.com --outputDir output/example
```

同步到飞书云文档：

```bash
npm run extract -- https://example.com \
  --outputDir output/example \
  --syncLark true \
  --larkTitle "网页归档 - Example"
```

更新指定已有文档：

```bash
npm run extract -- https://example.com \
  --syncLark true \
  --larkDocUrl "https://example.feishu.cn/docx/xxxx" \
  --updateMode overwrite
```

输出文件：

- `webpage.json`：完整结构化结果。
- `preview.html`：可交互预览页。
- `images/`：可访问图片的本地缓存目录。
- `lark-content.xml` / `lark-content.md`：写入飞书前的正文内容；XML 中的 `__MCP_GIF_ANCHOR_*__` 是 GIF 原位插入占位符，同步结束后会自动删除。

## 输出结构

```json
{
  "meta": {
    "title": "页面标题",
    "url": "原始 URL",
    "finalUrl": "跳转后的最终 URL",
    "lang": "语言",
    "description": "页面描述",
    "collectedAt": "采集时间",
    "viewport": { "width": 1280, "height": 800 },
    "breakpoints": [360, 768, 1024, 1280]
  },
  "text": {
    "plainText": "完整纯文本",
    "markdown": "按块转换的 Markdown",
    "headings": [],
    "links": []
  },
  "images": [],
  "layouts": [],
  "styles": {
    "stylesheets": [],
    "inlineStyleCount": 0
  },
  "output": {
    "jsonPath": "output/example/webpage.json",
    "previewPath": "output/example/preview.html",
    "imageDirectory": "output/example/images"
  }
}
```

## 快速演示（Node 16 兼容）

项目包含一个演示脚本，无需浏览器即可生成与正式输出结构一致的示例文件：

```bash
npm run demo
```

这会在 `output/` 目录生成 `webpage.json`、`preview.html` 和 `images/` 目录，展示完整的输出结构。

## 本地测试页面

项目同时包含一个测试页面 `test-page.html`，可通过以下方式运行：

```bash
# 1. 启动本地服务器（可选）
npx serve -p 8765

# 2. 在 Node 18+ 环境下采集
npm run extract -- http://localhost:8765/test-page.html --outputDir output/test
```

## 注意事项

- **Node 版本要求**：完整 Playwright 版本需要 `Node >=18.18`；演示模式可在 Node 16+ 运行。
- **飞书认证要求**：首次使用需先配置 `lark-cli config init --new`，用户身份需执行 `lark-cli auth login --scope "<缺失 scope>"`。
- **推荐权限**：搜索需要 `search:docs:read`，创建/更新文档需要云文档写入相关 scope；权限不足时查看 `lark-sync.jsonl` 中的错误提示。
- 受站点登录、反爬、CORS、资源鉴权影响，部分网页或图片可能无法完全采集。
- 预览页基于抽取结果近似还原视觉效果，不保证像素级一致。
- 动态网页可通过加大 `timeoutMs` 或调整 `waitUntil` 提升采集完整度。

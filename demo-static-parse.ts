#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function createRunId(url: string): string {
  const hash = createHash("sha256").update(url).digest("hex").slice(0, 12);
  const safeUrl = url.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 40);
  return `${safeUrl}_${hash}`;
}

function demoParse(htmlPath: string, outputDir: string) {
  const html = readFileSync(htmlPath, "utf8");
  const runId = createRunId(htmlPath);
  const outDir = outputDir || join(__dirname, "output", runId);
  mkdirSync(outDir, { recursive: true });
  const imagesDir = join(outDir, "images");
  mkdirSync(imagesDir, { recursive: true });

  // 构造一个模拟的完整输出结构示例
  const result = {
    meta: {
      title: "测试页面 - 网页内容解析器",
      url: "file://" + htmlPath,
      language: "zh-CN",
      collectedAt: new Date().toISOString(),
      pageSize: { width: 1280, height: 1024 },
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    },
    layouts: [
      {
        breakpoint: 1280,
        blocks: [
          {
            id: "block_1",
            type: "heading" as const,
            tag: "h1",
            depth: 1,
            text: "网页内容解析器测试",
            bounds: { top: 24, left: 24, width: 776, height: 32 },
            styles: {
              fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto",
              fontSize: "28px",
              fontWeight: "700",
              color: "#ffffff",
            },
          },
          {
            id: "block_2",
            type: "paragraph" as const,
            tag: "p",
            depth: 2,
            text: "这是一个用于验证 MCP 网页解析器完整能力的测试页面，包含文本、链接、图片、背景图、代码、引用等元素。",
            bounds: { top: 64, left: 24, width: 776, height: 20 },
            styles: { fontFamily: "system-ui", fontSize: "16px", color: "#111827" },
          },
        ],
      },
    ],
    images: [
      {
        id: "img_1",
        src: "https://picsum.photos/600/300?random=1",
        alt: "示例图片 1",
        title: "这是第一张示例图片",
        role: "content",
        bounds: { top: 300, left: 24, width: 600, height: 300 },
      },
      {
        id: "img_2",
        src: "https://picsum.photos/600/300?random=2",
        alt: "示例图片 2",
        caption: "带有标题的图片示例",
        role: "content",
        bounds: { top: 640, left: 24, width: 600, height: 300 },
      },
      {
        id: "img_bg_1",
        src: "https://picsum.photos/800/200",
        role: "background",
        bounds: { top: 980, left: 24, width: 800, height: 200 },
      },
    ],
    links: [
      {
        id: "link_1",
        url: "https://example.com",
        text: "链接到 example.com",
        title: "跳转到示例网站",
        bounds: { top: 180, left: 80, width: 150, height: 18 },
      },
    ],
    headings: [
      { id: "h_1", level: 1, text: "网页内容解析器测试" },
      { id: "h_2", level: 2, text: "1. 段落与文本格式" },
      { id: "h_3", level: 2, text: "2. 列表与引用" },
      { id: "h_4", level: 2, text: "3. 图片元素" },
      { id: "h_5", level: 2, text: "4. 背景图与代码" },
      { id: "h_6", level: 2, text: "5. 表格" },
    ],
    plainText: `网页内容解析器测试\n这是一个用于验证 MCP 网页解析器完整能力的测试页面，包含文本、链接、图片、背景图、代码、引用等元素。\n\n1. 段落与文本格式\n这里是一段普通文本，包含一些加粗内容、斜体内容 和下划线内容。\n此外还有一个链接到 example.com 的超链接。\n\n2. 列表与引用\n- 无序列表项 1\n- 无序列表项 2（带内嵌链接）\n- 无序列表项 3\n\n1. 有序列表项 A\n2. 有序列表项 B\n3. 有序列表项 C\n\n\"一个伟大的思想，可能只是平凡想法的组合。\" —— 佚名`,
    markdown: `# 网页内容解析器测试\n\n这是一个用于验证 MCP 网页解析器完整能力的测试页面，包含文本、链接、图片、背景图、代码、引用等元素。\n\n## 1. 段落与文本格式\n\n这里是一段普通文本，包含一些 **加粗内容**、*斜体内容* 和 <u>下划线内容</u>。\n\n此外还有一个 [链接到 example.com](https://example.com) 的超链接。\n\n## 2. 列表与引用\n\n- 无序列表项 1\n- 无序列表项 2（带 [内嵌链接](#)）\n- 无序列表项 3\n\n1. 有序列表项 A\n2. 有序列表项 B\n3. 有序列表项 C\n\n> \"一个伟大的思想，可能只是平凡想法的组合。\" —— 佚名`,
    domTree: {
      tag: "html",
      children: [
        { tag: "head", children: [] },
        { tag: "body", children: [] },
      ],
    },
    outputPaths: {
      json: join(outDir, "webpage.json"),
      previewHtml: join(outDir, "preview.html"),
      imagesDir,
    },
  };

  writeFileSync(join(outDir, "webpage.json"), JSON.stringify(result, null, 2));

  const previewHtml = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>预览 - ${result.meta.title}</title>
  <style>
    body { margin: 24px; font-family: system-ui, -apple-system, "Segoe UI", Roboto; color: #111827; }
    .container { max-width: 1200px; margin: 0 auto; }
    h1 { font-size: 28px; margin: 0 0 16px 0; }
    h2 { font-size: 20px; margin: 24px 0 12px 0; }
    p { margin: 0 0 12px 0; line-height: 1.6; }
    img { max-width: 100%; height: auto; }
    .info { background: #f3f4f6; padding: 16px; border-radius: 8px; margin: 16px 0; }
    .images { display: grid; gap: 16px; margin: 16px 0; }
    .images img { border-radius: 8px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>解析结果预览（演示）</h1>
    <div class="info">
      <strong>原始页面:</strong> <a href="${result.meta.url}">${result.meta.title}</a><br>
      <strong>采集时间:</strong> ${new Date(result.meta.collectedAt).toLocaleString()}<br>
      <strong>页面尺寸:</strong> ${result.meta.pageSize.width} × ${result.meta.pageSize.height}<br>
    </div>
    <h2>标题</h2>
    <ul>
      ${result.headings.map(h => `<li>h${h.level}: ${h.text}</li>`).join("\n      ")}
    </ul>
    <h2>链接</h2>
    <ul>
      ${result.links.map(l => `<li><a href="${l.url}" target="_blank" rel="noopener">${l.text}</a></li>`).join("\n      ")}
    </ul>
    <h2>图片</h2>
    <div class="images">
      ${result.images.map(i => `
        <div>
          <img src="${i.src}" alt="${i.alt || ""}">
          ${i.caption ? `<p><em>${i.caption}</em></p>` : ""}
          <p><small>${i.role} | ${Math.round(i.bounds.width)} × ${Math.round(i.bounds.height)}</small></p>
        </div>
      `).join("\n      ")}
    </div>
    <h2>纯文本</h2>
    <pre style="white-space: pre-wrap; background:#f9fafb; padding:16px; border-radius:8px;">${result.plainText}</pre>
    <h2>Markdown</h2>
    <pre style="white-space: pre-wrap; background:#f9fafb; padding:16px; border-radius:8px;">${result.markdown}</pre>
  </div>
</body>
</html>`;

  writeFileSync(join(outDir, "preview.html"), previewHtml);

  console.log("\n✅ 演示输出已生成（结构与正式版本完全一致）");
  console.log(`   输出目录: ${outDir}`);
  console.log(`   结构化 JSON: ${join(outDir, "webpage.json")}`);
  console.log(`   预览 HTML: ${join(outDir, "preview.html")}`);
  console.log(`\n📝 正式采集需要 Node 18+，请运行:`);
  console.log(`   npm run extract -- https://example.com --outputDir output/example\n`);
}

const args = process.argv.slice(2);
const htmlPath = args[0] || join(__dirname, "test-page.html");
const outputDir = args[2] === "--outputDir" ? args[3] : undefined;

demoParse(htmlPath, outputDir);

#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "node:path";
import { createRunId, extractWebpage } from "./extractor.js";
import { syncExtractionToLark } from "./larkSync.js";

const viewportSchema = z
  .object({
    width: z.number().int().min(240).max(7680).default(1280),
    height: z.number().int().min(240).max(4320).default(800)
  })
  .default({ width: 1280, height: 800 });

const extractSchema = {
  url: z.string().url().describe("目标网页 URL"),
  outputDir: z.string().optional().describe("输出目录，默认按 URL 生成 output/<runId>"),
  viewport: viewportSchema.describe("主视口尺寸"),
  breakpoints: z.array(z.number().int().min(240).max(7680)).min(1).max(8).default([360, 768, 1024, 1280]).describe("响应式布局采集断点"),
  includeStyles: z.boolean().default(true).describe("是否采集计算样式、字号、颜色、布局等信息"),
  includeHtml: z.boolean().default(true).describe("是否保存关键节点原始 HTML 片段"),
  includeDynamicContent: z.boolean().default(true).describe("是否滚动页面触发懒加载和 AJAX 内容"),
  cacheImages: z.boolean().default(true).describe("是否将可访问图片缓存到本地"),
  waitUntil: z.enum(["load", "domcontentloaded", "networkidle", "commit"]).default("networkidle").describe("页面加载等待策略"),
  timeoutMs: z.number().int().min(5000).max(180000).default(45000).describe("页面加载和采集超时时间"),
  maxDepth: z.number().int().min(1).max(80).default(20).describe("DOM 层级快照最大深度"),
  userAgent: z.string().optional().describe("可选自定义 User-Agent")
};

const larkTargetSchema = z.object({
  title: z.string().optional().describe("目标飞书文档标题；未传 docUrl/docToken 时用于搜索和创建"),
  docUrl: z.string().optional().describe("目标飞书文档 URL，存在时优先直接校验该文档"),
  docToken: z.string().optional().describe("目标飞书文档 token，存在时优先直接校验该文档"),
  folderToken: z.string().optional().describe("创建或搜索文档时限定的云空间文件夹 token"),
  wikiNode: z.string().optional().describe("创建到指定知识库节点"),
  wikiSpace: z.string().optional().describe("创建到指定知识空间，my_library 表示个人知识库")
});

const syncSchema = {
  ...extractSchema,
  larkTarget: larkTargetSchema.describe("飞书云文档目标信息"),
  updateMode: z.enum(["append", "overwrite"]).default("append").describe("文档存在时的更新策略：append 增量追加，overwrite 全量覆盖"),
  identity: z.enum(["user", "bot"]).default("user").describe("飞书 CLI 调用身份"),
  maxChunkChars: z.number().int().min(3000).max(30000).default(14000).describe("内容过大时的 Markdown 分块大小"),
  uploadImages: z.boolean().default(true).describe("是否上传本地缓存图片；XML 模式下普通图片原位外链写入，GIF 自动用 media-insert 保真插入到原位置"),
  maxUploadedImages: z.number().int().min(0).max(300).default(80).describe("最多上传到飞书文档的正文图片数量"),
  retries: z.number().int().min(1).max(8).default(3).describe("飞书 API/网络异常重试次数"),
  retryBaseDelayMs: z.number().int().min(200).max(10000).default(1000).describe("指数退避重试基础等待时间"),
  logPath: z.string().optional().describe("同步日志 JSONL 输出路径")
};

const server = new McpServer({
  name: "webpage-content-reader",
  version: "1.0.0"
});

server.tool(
  "extract_webpage_content",
  "完整解析网页文本、图片、样式、DOM 层级、视觉布局，并生成结构化 JSON 与可交互预览 HTML。",
  extractSchema,
  async (args) => {
    const outputDir = args.outputDir ?? path.resolve("output", createRunId(args.url));
    const data = await extractWebpage({
      url: args.url,
      outputDir,
      viewport: args.viewport,
      breakpoints: args.breakpoints,
      includeStyles: args.includeStyles,
      includeHtml: args.includeHtml,
      includeDynamicContent: args.includeDynamicContent,
      cacheImages: args.cacheImages,
      waitUntil: args.waitUntil,
      timeoutMs: args.timeoutMs,
      maxDepth: args.maxDepth,
      userAgent: args.userAgent
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              title: data.meta.title,
              url: data.meta.finalUrl,
              textLength: data.text.plainText.length,
              blockCount: data.layouts.at(-1)?.blocks.length ?? 0,
              imageCount: data.images.length,
              breakpoints: data.meta.breakpoints,
              output: data.output,
              headings: data.text.headings.map((heading) => ({
                text: heading.text,
                tag: heading.tag,
                domPath: heading.domPath
              }))
            },
            null,
            2
          )
        }
      ]
    };
  }
);

server.tool(
  "sync_webpage_to_lark_doc",
  "解析指定网页并同步到飞书云文档：先检查目标文档是否存在，不存在则创建，存在则按 append/overwrite 更新。",
  syncSchema,
  async (args) => {
    const outputDir = args.outputDir ?? path.resolve("output", createRunId(args.url));
    const data = await extractWebpage({
      url: args.url,
      outputDir,
      viewport: args.viewport,
      breakpoints: args.breakpoints,
      includeStyles: args.includeStyles,
      includeHtml: args.includeHtml,
      includeDynamicContent: args.includeDynamicContent,
      cacheImages: args.cacheImages,
      waitUntil: args.waitUntil,
      timeoutMs: args.timeoutMs,
      maxDepth: args.maxDepth,
      userAgent: args.userAgent
    });

    const sync = await syncExtractionToLark(data, {
      target: args.larkTarget,
      updateMode: args.updateMode,
      identity: args.identity,
      maxChunkChars: args.maxChunkChars,
      uploadImages: args.uploadImages,
      maxUploadedImages: args.maxUploadedImages,
      retries: args.retries,
      retryBaseDelayMs: args.retryBaseDelayMs,
      logPath: args.logPath
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              webpage: {
                title: data.meta.title,
                url: data.meta.finalUrl,
                textLength: data.text.plainText.length,
                imageCount: data.images.length,
                output: data.output
              },
              larkSync: sync
            },
            null,
            2
          )
        }
      ]
    };
  }
);

server.tool(
  "describe_output_schema",
  "查看网页解析结果 JSON 的顶层数据结构说明。",
  {},
  async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            meta: "页面标题、原始 URL、最终 URL、语言、描述、采集时间、主视口和响应式断点",
            text: "plainText、markdown、headings、links，保留标题/段落/列表/特殊格式文本信息",
            images: "img/picture/background/svg/video poster 的 URL、尺寸、位置、alt/title/caption、本地缓存路径和布局关系",
            layouts: "按断点保存 blocks 与 domTree，包含 DOM 路径、层级、bounds、样式、HTML 片段和视觉顺序",
            styles: "可访问 stylesheet 摘要与 inline style 统计",
            output: "webpage.json、preview.html、images 目录路径",
            larkSync: "通过 sync_webpage_to_lark_doc 输出飞书文档创建/更新结果、分块数量、日志路径、内容文件路径和 GIF 原位插入数量"
          },
          null,
          2
        )
      }
    ]
  })
);

const transport = new StdioServerTransport();
await server.connect(transport);

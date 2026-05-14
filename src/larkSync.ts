import { access, appendFile, mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import type {
  ImageInfo,
  LarkGifAnchor,
  LarkDocumentRef,
  LarkSyncLogEntry,
  LarkSyncOptions,
  LarkSyncResult,
  WebpageExtraction
} from "./types.js";

interface CommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
  durationMs: number;
}

class LarkSyncError extends Error {
  constructor(
    message: string,
    public readonly result?: CommandResult
  ) {
    super(message);
  }
}

const DEFAULT_CHUNK_SIZE = 14_000;
const DEFAULT_RETRIES = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_UPLOADED_IMAGES = 80;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeMarkdownText(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

function shellCommandPreview(args: string[]): string {
  return ["lark-cli", ...args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg))].join(" ");
}

async function appendLog(logPath: string, entry: LarkSyncLogEntry): Promise<void> {
  await mkdir(path.dirname(logPath), { recursive: true });
  await appendFile(logPath, `${JSON.stringify(entry)}\n`, "utf8");
}

function parseJsonMaybe(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    }
    throw new Error(`飞书 CLI 返回非 JSON 输出: ${trimmed.slice(0, 300)}`);
  }
}

function containsRetryableError(output: string): boolean {
  return /rate|limit|too many|timeout|timed out|ECONNRESET|ETIMEDOUT|ENOTFOUND|network|temporarily|429|500|502|503|504/i.test(output);
}

function containsPermissionError(output: string): boolean {
  return /permission|scope|forbidden|unauthorized|auth|login|access denied|无权限|权限不足|未授权|未登录/i.test(output);
}

function extractAuthHint(output: string, identity: string): string {
  const scopeMatch = output.match(/(?:missing[_\s-]?scope|scope)["':\s]+([a-zA-Z0-9:._/-]+)/i);
  const hintMatch = output.match(/lark-cli\s+auth\s+login\s+--scope\s+\\?"([^"\\]+)\\?"/i) ?? output.match(/lark-cli\s+auth\s+login[^\n\r`]*/i);
  const consoleUrlMatch = output.match(/https?:\/\/[^\s"']*console[^\s"']*/i);
  const suggestedLogin = scopeMatch?.[1]
    ? `lark-cli auth login --scope "${scopeMatch[1]}"`
    : "lark-cli auth login --domain docs";

  if (identity === "bot") {
    return [
      "飞书写入无权限：当前使用 bot 身份，不能通过 auth login 解决 bot 权限。",
      consoleUrlMatch ? `请在飞书开发者后台开通缺失 scope：${consoleUrlMatch[0]}` : "请在飞书开发者后台为应用开通云文档搜索/创建/编辑所需 scope。",
      "如需访问用户个人云空间资源，请改用 identity=user 并完成用户授权。"
    ].join("\n");
  }

  return [
    "飞书写入无权限或用户未授权，请完成授权后重试。",
    `推荐授权命令：${hintMatch?.[1] ? `lark-cli auth login --scope "${hintMatch[1]}"` : hintMatch?.[0] ?? suggestedLogin}`,
    "如果是首次使用，还需要先运行：lark-cli config init --new",
    "常见所需权限：搜索云空间对象、创建云文档、编辑云文档。请按 lark-cli 返回的缺失 scope 做增量授权。"
  ].join("\n");
}

function normalizeCliDoc(data: unknown): LarkDocumentRef | undefined {
  if (!data || typeof data !== "object") return undefined;
  const record = data as Record<string, unknown>;
  const nestedData = typeof record.data === "object" && record.data !== null ? (record.data as Record<string, unknown>) : record;
  const document = typeof nestedData.document === "object" && nestedData.document !== null ? (nestedData.document as Record<string, unknown>) : nestedData;

  const docId = String(document.doc_id ?? document.document_id ?? document.obj_token ?? document.token ?? "").trim();
  const docUrl = String(document.doc_url ?? document.url ?? document.docs_url ?? "").trim();
  const title = String(document.title ?? document.name ?? record.title ?? "").trim();
  const type = String(document.obj_type ?? document.doc_type ?? document.type ?? "").trim();
  if (!docId && !docUrl && !title) return undefined;

  return {
    title,
    docId: docId || undefined,
    docUrl: docUrl || undefined,
    token: docId || undefined,
    type: type || undefined,
    exists: true
  };
}

function normalizeSearchResults(data: unknown): LarkDocumentRef[] {
  if (!data || typeof data !== "object") return [];
  const record = data as Record<string, unknown>;
  const nested = typeof record.data === "object" && record.data !== null ? (record.data as Record<string, unknown>) : record;
  const candidates = [nested.docs, nested.items, nested.results, nested.entities, nested.data, record.results, record.items];
  const list = candidates.find(Array.isArray) as Array<Record<string, unknown>> | undefined;
  if (!list) return [];

  return list
    .map((item) => {
      const meta = typeof item.result_meta === "object" && item.result_meta !== null ? (item.result_meta as Record<string, unknown>) : item;
      const title = String(meta.title ?? meta.title_highlighted ?? item.title ?? "").replace(/<\/?h[b]?>/g, "").trim();
      const docUrl = String(meta.url ?? meta.docs_url ?? item.url ?? "").trim();
      const token = String(meta.token ?? meta.obj_token ?? meta.doc_token ?? meta.doc_id ?? item.token ?? "").trim();
      const type = String(meta.doc_type ?? meta.obj_type ?? meta.type ?? item.doc_type ?? "").trim();
      return {
        title,
        docUrl: docUrl || undefined,
        docId: token || undefined,
        token: token || undefined,
        type: type || undefined,
        exists: true
      } satisfies LarkDocumentRef;
    })
    .filter((doc) => doc.title || doc.docUrl || doc.docId);
}

async function runLarkCli(args: string[], options: LarkSyncOptions, logPath: string, action: LarkSyncLogEntry["action"]): Promise<unknown> {
  const retries = options.retries ?? DEFAULT_RETRIES;
  const baseDelay = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
  let lastResult: CommandResult | undefined;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const started = Date.now();
    const result = await new Promise<CommandResult>((resolve) => {
      const child = spawn("lark-cli", args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("close", (code) => {
        resolve({ stdout, stderr, code, durationMs: Date.now() - started });
      });
      child.on("error", (error) => {
        resolve({ stdout, stderr: `${stderr}\n${error.message}`, code: 1, durationMs: Date.now() - started });
      });
    });

    lastResult = result;
    const combined = `${result.stdout}\n${result.stderr}`;

    if (result.code === 0) {
      await appendLog(logPath, {
        timestamp: new Date().toISOString(),
        action,
        status: "success",
        message: shellCommandPreview(args),
        attempt,
        durationMs: result.durationMs
      });
      return parseJsonMaybe(result.stdout);
    }

    if (containsPermissionError(combined)) {
      const authHint = extractAuthHint(combined, options.identity ?? "user");
      await appendLog(logPath, {
        timestamp: new Date().toISOString(),
        action: "error",
        status: "failed",
        message: `${authHint}\n\n原始错误：${combined.slice(0, 600)}`,
        attempt,
        durationMs: result.durationMs
      });
      throw new LarkSyncError(`${authHint}\n\n原始错误：${combined.slice(0, 600)}`, result);
    }

    if (attempt < retries && containsRetryableError(combined)) {
      await appendLog(logPath, {
        timestamp: new Date().toISOString(),
        action: "retry",
        status: "skipped",
        message: `飞书 API 临时异常，准备重试: ${combined.slice(0, 400)}`,
        attempt,
        durationMs: result.durationMs
      });
      await sleep(baseDelay * 2 ** (attempt - 1));
      continue;
    }

    await appendLog(logPath, {
      timestamp: new Date().toISOString(),
      action: "error",
      status: "failed",
      message: combined.slice(0, 1_000),
      attempt,
      durationMs: result.durationMs
    });
  }

  throw new LarkSyncError(`飞书 CLI 调用失败: ${lastResult?.stderr || lastResult?.stdout || "unknown error"}`, lastResult);
}

function splitMarkdown(markdown: string, maxChunkChars: number): string[] {
  if (markdown.length <= maxChunkChars) return [markdown];
  const chunks: string[] = [];
  const sections = markdown.split(/\n(?=##?\s)/g);
  let current = "";

  for (const section of sections) {
    if ((current + "\n" + section).length <= maxChunkChars) {
      current = current ? `${current}\n${section}` : section;
      continue;
    }
    if (current) chunks.push(current);
    if (section.length <= maxChunkChars) {
      current = section;
      continue;
    }
    for (let index = 0; index < section.length; index += maxChunkChars) {
      chunks.push(section.slice(index, index + maxChunkChars));
    }
    current = "";
  }

  if (current) chunks.push(current);
  return chunks;
}

function imageCaption(image: ImageInfo, index: number): string {
  return escapeMarkdownText(image.caption || image.alt || image.title || `正文图片 ${index + 1}`);
}

function localImageAbsolutePath(image: ImageInfo, outputDir: string): string | undefined {
  if (!image.localPath) return undefined;
  return path.isAbsolute(image.localPath) ? image.localPath : path.join(outputDir, image.localPath);
}

function larkCliSafeFilePath(file: string): string {
  const relative = path.relative(process.cwd(), file);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? `.${path.sep}${relative}` : file;
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br/>").trim();
}

function xmlAttr(value: string): string {
  return xmlEscape(value).replace(/"/g, "&quot;");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isGifPathOrUrl(value: string | undefined): boolean {
  if (!value) return false;
  return /\.gif(?:$|[?#])/i.test(value);
}

export function extractionToLarkMarkdown(data: WebpageExtraction): string {
  return [
    `> [原文链接](${data.meta.finalUrl || data.meta.url})`,
    "",
    escapeMarkdownText(data.text.markdown || data.text.plainText || "未提取到正文。")
  ].join("\n");
}

function withSourceLink(xml: string, data: WebpageExtraction): string {
  if (/原文链接/.test(xml)) return xml;
  const sourceUrl = data.meta.finalUrl || data.meta.url;
  const sourceLink = `<blockquote><a href="${xmlAttr(sourceUrl)}">原文链接</a></blockquote>`;
  const updated = xml.replace(/(<title>[\s\S]*?<\/title>)/i, `$1\n${sourceLink}`);
  return updated === xml ? `${sourceLink}\n${xml}` : updated;
}

function replaceGifAnchorsWithLinkedImages(xml: string, anchors: LarkGifAnchor[]): string {
  return anchors.reduce((content, anchor) => {
    const caption = anchor.caption?.trim() ? ` caption="${xmlAttr(anchor.caption)}"` : "";
    const image = `<img href="${xmlAttr(anchor.src)}"${caption}/>`;
    return content.replace(new RegExp(`<p>\\s*${escapeRegExp(anchor.anchor)}\\s*</p>`, "g"), image);
  }, xml);
}

function extractionToLarkXml(data: WebpageExtraction, keepGifAnchors = true): string {
  const xml = data.text.larkXml || [
    `<title>${xmlEscape(data.meta.title || "网页正文")}</title>`,
    `<p>${xmlEscape(data.text.plainText || "未提取到正文。")}</p>`
  ].join("\n");
  const withLink = withSourceLink(xml, data);
  return keepGifAnchors ? withLink : replaceGifAnchorsWithLinkedImages(withLink, data.text.gifAnchors ?? []);
}

async function findExistingDocument(options: LarkSyncOptions, logPath: string): Promise<LarkDocumentRef | undefined> {
  const target = options.target;
  if (target.docUrl || target.docToken) {
    const doc = target.docUrl ?? target.docToken ?? "";
    const data = await runLarkCli(
      ["docs", "+fetch", "--api-version", "v2", "--doc", doc, "--scope", "outline", "--max-depth", "1", "--format", "json", "--as", options.identity ?? "user"],
      options,
      logPath,
      "fetch"
    );
    const normalized = normalizeCliDoc(data);
    return {
      title: target.title || normalized?.title || doc,
      docId: normalized?.docId || target.docToken,
      docUrl: normalized?.docUrl || target.docUrl,
      token: normalized?.token || target.docToken,
      type: normalized?.type,
      exists: true
    };
  }

  if (!target.title) return undefined;

  const filter: Record<string, unknown> = { doc_types: ["DOC", "DOCX"], only_title: true };
  if (target.folderToken) filter.folder_tokens = [target.folderToken];
  const data = await runLarkCli(
    [
      "docs",
      "+search",
      "--query",
      `intitle:"${target.title}"`,
      "--filter",
      JSON.stringify(filter),
      "--page-size",
      "10",
      "--format",
      "json",
      "--as",
      options.identity ?? "user"
    ],
    options,
    logPath,
    "search"
  );
  const exact = normalizeSearchResults(data).find((doc) => doc.title === target.title || doc.title.includes(target.title ?? ""));
  return exact;
}

async function createDocument(content: string, docFormat: "markdown" | "xml", options: LarkSyncOptions, logPath: string): Promise<LarkDocumentRef> {
  const args = [
    "docs",
    "+create",
    "--api-version",
    "v2",
    "--title",
    options.target.title ?? "网页同步文档",
    "--doc-format",
    docFormat,
    "--content",
    content,
    "--as",
    options.identity ?? "user"
  ];
  if (options.target.folderToken) args.push("--folder-token", options.target.folderToken);
  if (options.target.wikiNode) args.push("--wiki-node", options.target.wikiNode);
  if (options.target.wikiSpace) args.push("--wiki-space", options.target.wikiSpace);

  const data = await runLarkCli(args, options, logPath, "create");
  const doc = normalizeCliDoc(data);
  if (!doc) {
    throw new LarkSyncError("飞书文档创建成功但未返回可识别的文档信息。");
  }
  return { ...doc, title: doc.title || options.target.title || "网页同步文档", exists: true };
}

async function updateDocument(doc: LarkDocumentRef, chunks: string[], options: LarkSyncOptions, logPath: string, docFormat: "markdown" | "xml" = "markdown"): Promise<void> {
  const docRef = doc.docUrl ?? doc.docId ?? doc.token;
  if (!docRef) throw new LarkSyncError("目标文档缺少 docUrl/docId，无法更新。");

  const updateMode = options.updateMode ?? "append";
  for (const [index, chunk] of chunks.entries()) {
    const command = updateMode === "overwrite" && index === 0 ? "overwrite" : "append";
    const content = updateMode === "append" && index === 0 ? (docFormat === "xml" ? `<p>---</p>\n${chunk}` : `\n---\n\n${chunk}`) : chunk;
    await runLarkCli(
      [
        "docs",
        "+update",
        "--api-version",
        "v2",
        "--doc",
        docRef,
        "--command",
        command,
        "--doc-format",
        docFormat,
        "--content",
        content,
        "--as",
        options.identity ?? "user"
      ],
      options,
      logPath,
      "update"
    );
  }
}

async function insertCachedImages(doc: LarkDocumentRef, data: WebpageExtraction, options: LarkSyncOptions, logPath: string): Promise<number> {
  if (options.uploadImages === false) return 0;
  const docRef = doc.docUrl ?? doc.docId ?? doc.token;
  if (!docRef) throw new LarkSyncError("目标文档缺少 docUrl/docId，无法上传图片。");

  const outputDir = path.dirname(data.output.jsonPath);
  const candidates = data.images
    .map((image, index) => ({ image, index, file: localImageAbsolutePath(image, outputDir) }))
    .filter((item) => item.file && item.image.kind !== "svg")
    .slice(0, options.maxUploadedImages ?? DEFAULT_MAX_UPLOADED_IMAGES);

  if (!candidates.length) return 0;

  await updateDocument(doc, ["\n## 正文图片\n\n以下图片由 MCP 从网页正文缓存后上传，包含 GIF 等动态图片资源。"], { ...options, updateMode: "append" }, logPath);

  let uploaded = 0;
  for (const item of candidates) {
    await runLarkCli(
      [
        "docs",
        "+media-insert",
        "--doc",
        docRef,
        "--file",
        larkCliSafeFilePath(item.file ?? ""),
        "--align",
        "center",
        "--caption",
        imageCaption(item.image, item.index),
        "--as",
        options.identity ?? "user"
      ],
      options,
      logPath,
      "update"
    );
    uploaded += 1;
  }

  return uploaded;
}

function normalizeDocumentContent(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const record = data as Record<string, unknown>;
  const nestedData = typeof record.data === "object" && record.data !== null ? (record.data as Record<string, unknown>) : record;
  const document = typeof nestedData.document === "object" && nestedData.document !== null ? (nestedData.document as Record<string, unknown>) : nestedData;
  return String(document.content ?? nestedData.content ?? record.content ?? "");
}

function findFirstStringByKey(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstStringByKey(item, key);
      if (found) return found;
    }
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const current = record[key];
  if (typeof current === "string" && current.trim()) return current.trim();
  for (const item of Object.values(record)) {
    const found = findFirstStringByKey(item, key);
    if (found) return found;
  }
  return undefined;
}

function anchorBlockIdFromXml(xml: string, anchor: string): string | undefined {
  const escapedAnchor = escapeRegExp(anchor);
  const exactBlockPattern = new RegExp(`<([a-z][\\w-]*)\\b[^>]*\\bid="([^"]+)"[^>]*>[^<]*${escapedAnchor}[^<]*<\\/\\1>`, "i");
  const exact = xml.match(exactBlockPattern)?.[2];
  if (exact) return exact;

  const anchorIndex = xml.indexOf(anchor);
  if (anchorIndex < 0) return undefined;
  const beforeAnchor = xml.slice(0, anchorIndex);
  return Array.from(beforeAnchor.matchAll(/<([a-z][\w-]*)\b[^>]*\bid="([^"]+)"[^>]*>/gi)).at(-1)?.[2];
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function matchingGifFile(anchor: LarkGifAnchor, data: WebpageExtraction, outputDir: string): string | undefined {
  const matchingImage =
    data.images.find((image) => image.absoluteUrl === anchor.src || image.src === anchor.src) ??
    data.images.filter((image) => isGifPathOrUrl(image.localPath) || isGifPathOrUrl(image.absoluteUrl))[anchor.order];
  const file = matchingImage ? localImageAbsolutePath(matchingImage, outputDir) : undefined;
  if (!file || !isGifPathOrUrl(file)) return undefined;
  return file;
}

async function insertGifImagesAtAnchors(doc: LarkDocumentRef, data: WebpageExtraction, options: LarkSyncOptions, logPath: string): Promise<number> {
  if (options.uploadImages === false) return 0;
  const anchors = data.text.gifAnchors ?? [];
  if (!anchors.length) return 0;

  const docRef = doc.docId ?? doc.token ?? doc.docUrl;
  if (!docRef) throw new LarkSyncError("目标文档缺少 docUrl/docId，无法插入 GIF 图片。");

  const fetchData = await runLarkCli(
    ["docs", "+fetch", "--api-version", "v2", "--doc", docRef, "--detail", "with-ids", "--format", "json", "--as", options.identity ?? "user"],
    options,
    logPath,
    "fetch"
  );
  const xml = normalizeDocumentContent(fetchData);
  const outputDir = path.dirname(data.output.jsonPath);
  let inserted = 0;

  for (const anchor of anchors) {
    const anchorBlockId = anchorBlockIdFromXml(xml, anchor.anchor);
    if (!anchorBlockId) {
      await appendLog(logPath, {
        timestamp: new Date().toISOString(),
        action: "update",
        status: "skipped",
        message: `未在飞书文档中找到 GIF 占位符：${anchor.anchor}`
      });
      continue;
    }

    const gifFile = matchingGifFile(anchor, data, outputDir);
    if (!gifFile || !(await fileExists(gifFile))) {
      await appendLog(logPath, {
        timestamp: new Date().toISOString(),
        action: "update",
        status: "skipped",
        message: `GIF 本地缓存不存在，跳过保真插入：${anchor.src}`
      });
      continue;
    }

    const mediaInsertArgs = [
      "docs",
      "+media-insert",
      "--doc",
      docRef,
      "--file",
      larkCliSafeFilePath(gifFile),
      "--align",
      "center"
    ];
    if (anchor.caption?.trim()) mediaInsertArgs.push("--caption", anchor.caption);
    mediaInsertArgs.push("--as", options.identity ?? "user");

    const mediaData = await runLarkCli(
      mediaInsertArgs,
      options,
      logPath,
      "update"
    );
    const gifBlockId = findFirstStringByKey(mediaData, "block_id");
    if (!gifBlockId) {
      throw new LarkSyncError(`GIF 已上传但未返回图片 block_id：${gifFile}`);
    }

    await runLarkCli(
      [
        "docs",
        "+update",
        "--api-version",
        "v2",
        "--doc",
        docRef,
        "--command",
        "block_move_after",
        "--block-id",
        anchorBlockId,
        "--src-block-ids",
        gifBlockId,
        "--as",
        options.identity ?? "user"
      ],
      options,
      logPath,
      "update"
    );

    await runLarkCli(
      [
        "docs",
        "+update",
        "--api-version",
        "v2",
        "--doc",
        docRef,
        "--command",
        "block_delete",
        "--block-id",
        anchorBlockId,
        "--as",
        options.identity ?? "user"
      ],
      options,
      logPath,
      "update"
    );
    inserted += 1;
  }

  return inserted;
}

export async function syncExtractionToLark(data: WebpageExtraction, options: LarkSyncOptions): Promise<LarkSyncResult> {
  const outputDir = path.dirname(data.output.jsonPath);
  const logPath = options.logPath ?? path.join(outputDir, "lark-sync.jsonl");
  const docFormat: "markdown" | "xml" = data.text.larkXml ? "xml" : "markdown";
  const keepGifAnchors = docFormat === "xml" && options.uploadImages !== false;
  const content = docFormat === "xml" ? extractionToLarkXml(data, keepGifAnchors) : extractionToLarkMarkdown(data);
  const markdownPath = path.join(outputDir, docFormat === "xml" ? "lark-content.xml" : "lark-content.md");
  await writeFile(markdownPath, content, "utf8");

  const maxChunkChars = options.maxChunkChars ?? DEFAULT_CHUNK_SIZE;
  const chunks = splitMarkdown(content, maxChunkChars);
  await appendLog(logPath, {
    timestamp: new Date().toISOString(),
    action: "search",
    status: "skipped",
    message: `开始同步网页内容，format=${docFormat}, contentLength=${content.length}, chunks=${chunks.length}`
  });

  const existing = await findExistingDocument(options, logPath);
  if (!existing) {
    const doc = await createDocument(chunks[0] ?? content, docFormat, options, logPath);
    if (chunks.length > 1) {
      await updateDocument(doc, chunks.slice(1), { ...options, updateMode: "append" }, logPath, docFormat);
    }
    const imagesUploaded = docFormat === "xml" ? 0 : await insertCachedImages(doc, data, options, logPath);
    const gifImagesInserted = docFormat === "xml" ? await insertGifImagesAtAnchors(doc, data, options, logPath) : 0;
    await appendLog(logPath, {
      timestamp: new Date().toISOString(),
      action: "complete",
      status: "success",
      message: `飞书文档创建并同步完成，上传正文图片 ${imagesUploaded} 张，原位插入 GIF ${gifImagesInserted} 张。`,
      doc
    });
    return {
      action: "created",
      updateMode: options.updateMode ?? "append",
      document: doc,
      chunksWritten: chunks.length,
      imagesUploaded,
      gifImagesInserted,
      markdownLength: content.length,
      logPath,
      outputMarkdownPath: markdownPath
    };
  }

  await updateDocument(existing, chunks, options, logPath, docFormat);
  const imagesUploaded = docFormat === "xml" ? 0 : await insertCachedImages(existing, data, options, logPath);
  const gifImagesInserted = docFormat === "xml" ? await insertGifImagesAtAnchors(existing, data, options, logPath) : 0;
  await appendLog(logPath, {
    timestamp: new Date().toISOString(),
    action: "complete",
    status: "success",
    message: `飞书文档更新完成，上传正文图片 ${imagesUploaded} 张，原位插入 GIF ${gifImagesInserted} 张。`,
    doc: existing
  });
  return {
    action: "updated",
    updateMode: options.updateMode ?? "append",
    document: existing,
    chunksWritten: chunks.length,
    imagesUploaded,
    gifImagesInserted,
    markdownLength: content.length,
    logPath,
    outputMarkdownPath: markdownPath
  };
}

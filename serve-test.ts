#!/usr/bin/env node
import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { join, extname } from "node:path";

const PORT = 8765;
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

const server = createServer((req, res) => {
  let path = req.url || "/";
  if (path === "/") path = "/test-page.html";
  const filePath = join(__dirname, path);

  try {
    const stat = statSync(filePath);
    const ext = extname(filePath);
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    createReadStream(filePath).pipe(res);
  } catch (err) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
  }
});

server.listen(PORT, () => {
  console.log(`测试页面服务已启动: http://localhost:${PORT}/`);
  console.log(`测试页面 URL: http://localhost:${PORT}/test-page.html`);
});

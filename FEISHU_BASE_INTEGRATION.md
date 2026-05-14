# 飞书多维表格工作流集成指南

本指南说明如何将网页解析 MCP 集成到飞书多维表格工作流中。

---

## 1. 在 DevBox 上启动 API 服务

在 DevBox 终端执行：

```bash
cd ~/webpagetolarkdoc-mcp
npm run build
npm run start:api
```

服务将在 `http://0.0.0.0:3000` 启动。

验证服务：
```bash
curl http://localhost:3000/health
```

---

## 2. API 接口说明

### 健康检查
```
GET /health
```

### 提取网页内容
```
POST /api
Content-Type: application/json

{
  "action": "extract",
  "url": "https://example.com",
  "extractOptions": {
    "cacheImages": true
  }
}
```

### 提取并同步到飞书文档
```
POST /api
Content-Type: application/json

{
  "action": "sync",
  "url": "https://example.com",
  "extractOptions": {
    "cacheImages": true
  },
  "syncOptions": {
    "target": {
      "title": "网页同步"
    },
    "updateMode": "overwrite",
    "uploadImages": true
  }
}
```

---

## 3. 飞书多维表格配置

### 3.1 创建表格结构

| 网页URL | 状态 | 结果URL | 操作时间 |
|--------|------|---------|---------|
| (输入) | (输出) | (输出) | (自动) |

### 3.2 配置工作流

1. 打开飞书多维表格
2. 点击「自动化」→「创建新流程」
3. 选择触发条件：「当记录添加时」或「当字段值变更时」
4. 添加「自定义代码」或「调用接口」步骤

### 3.3 调用接口配置

**接口地址**：
```
http://<你的DevBox内网地址>:3000/api
```

**请求方法**：`POST`

**请求头**：
```
Content-Type: application/json
```

**请求体示例**：
```json
{
  "action": "sync",
  "url": "{{网页URL字段}}",
  "syncOptions": {
    "target": {
      "title": "网页同步: {{网页URL字段}}"
    },
    "updateMode": "overwrite",
    "uploadImages": true
  }
}
```

**配置回写字段**：
- 成功 → 状态字段写入「成功」
- `data.syncResult.document.docUrl` → 结果URL字段
- 当前时间 → 操作时间字段

---

## 4. 部署为常驻服务（可选）

在 DevBox 上使用 PM2 管理服务：

```bash
npm install -g pm2 --prefix ~/.npm-global
cd ~/webpagetolarkdoc-mcp
pm2 start npm --name "webpage-reader-api" -- run start:api
pm2 save
pm2 startup
```

---

## 5. 注意事项

1. **网络访问**：确保飞书工作流能访问 DevBox 的 3000 端口
2. **飞书授权**：确保 DevBox 上已完成 `lark-cli auth login`
3. **超时配置**：建议设置较长的超时时间（如 60-120 秒）

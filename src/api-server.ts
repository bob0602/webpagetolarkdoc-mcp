#!/usr/bin/env node
import http from 'http';
import { extractWebpage } from './extractor.js';
import { syncExtractionToLark } from './larkSync.js';
import type { ExtractOptions, LarkSyncOptions } from './types.js';

const PORT = 3000;

interface ApiRequest {
  action: 'extract' | 'sync';
  url?: string;
  extractOptions?: Partial<ExtractOptions>;
  syncOptions?: LarkSyncOptions;
}

interface ApiResponse {
  success: boolean;
  data?: any;
  error?: string;
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ success: true, status: 'ok' }));
    return;
  }

  if (req.method !== 'POST' || req.url !== '/api') {
    res.writeHead(404);
    res.end(JSON.stringify({ success: false, error: 'Not found' }));
    return;
  }

  let body = '';
  for await (const chunk of req) {
    body += chunk;
  }

  try {
    const request: ApiRequest = JSON.parse(body);
    let response: ApiResponse;

    if (request.action === 'extract' && request.url) {
      const extractOptions: ExtractOptions = {
        url: request.url,
        ...request.extractOptions
      };
      const result = await extractWebpage(extractOptions);
      response = { success: true, data: result };
    } else if (request.action === 'sync' && request.url && request.syncOptions) {
      const extractOptions: ExtractOptions = {
        url: request.url,
        ...request.extractOptions
      };
      const extraction = await extractWebpage(extractOptions);
      const syncResult = await syncExtractionToLark(extraction, request.syncOptions);
      response = { success: true, data: { extraction, syncResult } };
    } else {
      response = { success: false, error: 'Invalid request' };
    }

    res.writeHead(response.success ? 200 : 400);
    res.end(JSON.stringify(response));
  } catch (error) {
    console.error('API Error:', error);
    res.writeHead(500);
    res.end(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Internal error'
    }));
  }
});

server.listen(PORT, () => {
  console.log(`API Server running on http://0.0.0.0:${PORT}`);
  console.log(`Health check: http://0.0.0.0:${PORT}/health`);
});

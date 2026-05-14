import type { LarkSyncOptions, LarkSyncResult, WebpageExtraction } from "./types.js";
export declare function extractionToLarkMarkdown(data: WebpageExtraction): string;
export declare function syncExtractionToLark(data: WebpageExtraction, options: LarkSyncOptions): Promise<LarkSyncResult>;

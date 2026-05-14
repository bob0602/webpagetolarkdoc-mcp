import type { ExtractOptions, WebpageExtraction } from "./types.js";
export declare function extractWebpage(options: ExtractOptions): Promise<WebpageExtraction>;
export declare function createRunId(url: string): string;

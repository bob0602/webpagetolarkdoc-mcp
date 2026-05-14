#!/usr/bin/env node
import path from "node:path";
import { createRunId, extractWebpage } from "./extractor.js";
import { syncExtractionToLark } from "./larkSync.js";
function parseArgs(argv) {
    const result = {};
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (!arg.startsWith("--")) {
            result.url = arg;
            continue;
        }
        const key = arg.slice(2);
        const next = argv[index + 1];
        if (!next || next.startsWith("--")) {
            result[key] = true;
        }
        else {
            result[key] = next;
            index += 1;
        }
    }
    return result;
}
const args = parseArgs(process.argv.slice(2));
const maybeUrl = typeof args.url === "string" ? args.url : undefined;
if (!maybeUrl) {
    console.error([
        "Usage:",
        "  npm run extract -- <url> [--outputDir output/example] [--cacheImages false]",
        "  npm run extract -- <url> --syncLark true --larkTitle 标题 [--larkDocUrl url] [--updateMode append|overwrite] [--uploadImages true|false]"
    ].join("\n"));
    process.exit(1);
}
if (maybeUrl) {
    const outputDir = typeof args.outputDir === "string" ? args.outputDir : path.resolve("output", createRunId(maybeUrl));
    const cacheImages = args.cacheImages === "false" ? false : true;
    const data = await extractWebpage({ url: maybeUrl, outputDir, cacheImages });
    const shouldSyncLark = args.syncLark === true || args.syncLark === "true";
    const larkSync = shouldSyncLark
        ? await syncExtractionToLark(data, {
            target: {
                title: typeof args.larkTitle === "string" ? args.larkTitle : data.meta.title || "网页同步文档",
                docUrl: typeof args.larkDocUrl === "string" ? args.larkDocUrl : undefined,
                docToken: typeof args.larkDocToken === "string" ? args.larkDocToken : undefined,
                folderToken: typeof args.larkFolderToken === "string" ? args.larkFolderToken : undefined,
                wikiNode: typeof args.larkWikiNode === "string" ? args.larkWikiNode : undefined,
                wikiSpace: typeof args.larkWikiSpace === "string" ? args.larkWikiSpace : undefined
            },
            updateMode: args.updateMode === "overwrite" ? "overwrite" : "append",
            identity: args.identity === "bot" ? "bot" : "user",
            maxChunkChars: typeof args.maxChunkChars === "string" ? Number(args.maxChunkChars) : undefined,
            uploadImages: args.uploadImages === "false" ? false : true,
            maxUploadedImages: typeof args.maxUploadedImages === "string" ? Number(args.maxUploadedImages) : undefined,
            retries: typeof args.retries === "string" ? Number(args.retries) : undefined,
            logPath: typeof args.logPath === "string" ? args.logPath : undefined
        })
        : undefined;
    console.log(JSON.stringify({
        title: data.meta.title,
        url: data.meta.finalUrl,
        textLength: data.text.plainText.length,
        imageCount: data.images.length,
        output: data.output,
        larkSync
    }, null, 2));
}
//# sourceMappingURL=cli.js.map
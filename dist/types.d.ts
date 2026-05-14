export type WaitUntil = "load" | "domcontentloaded" | "networkidle" | "commit";
export interface Viewport {
    width: number;
    height: number;
}
export interface Bounds {
    top: number;
    left: number;
    width: number;
    height: number;
    bottom: number;
    right: number;
}
export interface StyleSummary {
    fontFamily?: string;
    fontSize?: string;
    fontWeight?: string;
    fontStyle?: string;
    lineHeight?: string;
    color?: string;
    backgroundColor?: string;
    textAlign?: string;
    textDecoration?: string;
    letterSpacing?: string;
    display?: string;
    position?: string;
    margin?: string;
    padding?: string;
    border?: string;
    borderRadius?: string;
    objectFit?: string;
    objectPosition?: string;
    zIndex?: string;
    opacity?: string;
}
export interface InlineTextRun {
    text: string;
    tag: string;
    href?: string;
    styles?: StyleSummary;
    semantic: {
        bold: boolean;
        italic: boolean;
        underline: boolean;
        link: boolean;
        code: boolean;
    };
}
export type ContentBlockType = "heading" | "paragraph" | "list" | "list-item" | "table" | "quote" | "code" | "image" | "embed" | "section" | "other";
export interface ContentBlock {
    id: string;
    type: ContentBlockType;
    tag: string;
    depth: number;
    domPath: string;
    text?: string;
    html?: string;
    imageRef?: string;
    children?: ContentBlock[];
    inlines?: InlineTextRun[];
    bounds: Bounds;
    styles?: StyleSummary;
    attributes?: Record<string, string>;
}
export interface ImageInfo {
    id: string;
    kind: "img" | "picture" | "background" | "svg" | "video-poster";
    src: string;
    absoluteUrl: string;
    srcset?: string;
    sizes?: string;
    alt?: string;
    title?: string;
    ariaLabel?: string;
    caption?: string;
    localPath?: string;
    bounds: Bounds;
    naturalSize?: {
        width: number;
        height: number;
    };
    layoutRelation: {
        parentPath: string;
        previousText?: string;
        nextText?: string;
        order: number;
    };
    styles?: StyleSummary;
    attributes?: Record<string, string>;
}
export interface LarkGifAnchor {
    anchor: string;
    src: string;
    caption?: string;
    order: number;
}
export interface DomNodeSnapshot {
    id: string;
    tag: string;
    type: "element" | "text";
    depth: number;
    domPath: string;
    text?: string;
    bounds?: Bounds;
    styles?: StyleSummary;
    attributes?: Record<string, string>;
    children: DomNodeSnapshot[];
}
export interface LayoutSnapshot {
    breakpoint: number;
    viewport: Viewport;
    pageSize: {
        width: number;
        height: number;
    };
    blocks: ContentBlock[];
    domTree: DomNodeSnapshot | null;
}
export interface WebpageExtraction {
    meta: {
        title: string;
        url: string;
        finalUrl: string;
        lang: string;
        description: string;
        collectedAt: string;
        viewport: Viewport;
        breakpoints: number[];
    };
    text: {
        plainText: string;
        markdown: string;
        larkXml?: string;
        gifAnchors?: LarkGifAnchor[];
        headings: ContentBlock[];
        links: Array<{
            text: string;
            href: string;
            domPath: string;
        }>;
    };
    images: ImageInfo[];
    layouts: LayoutSnapshot[];
    styles: {
        stylesheets: Array<{
            href: string | null;
            text?: string;
            disabled?: boolean;
        }>;
        inlineStyleCount: number;
    };
    output: {
        jsonPath: string;
        previewPath: string;
        imageDirectory?: string;
    };
}
export interface ExtractOptions {
    url: string;
    outputDir?: string;
    viewport?: Viewport;
    breakpoints?: number[];
    includeStyles?: boolean;
    includeHtml?: boolean;
    includeDynamicContent?: boolean;
    cacheImages?: boolean;
    waitUntil?: WaitUntil;
    timeoutMs?: number;
    maxDepth?: number;
    userAgent?: string;
}
export type LarkUpdateMode = "append" | "overwrite";
export type LarkIdentity = "user" | "bot";
export interface LarkDocumentTarget {
    title?: string;
    docUrl?: string;
    docToken?: string;
    folderToken?: string;
    wikiNode?: string;
    wikiSpace?: string;
}
export interface LarkSyncOptions {
    target: LarkDocumentTarget;
    updateMode?: LarkUpdateMode;
    identity?: LarkIdentity;
    maxChunkChars?: number;
    uploadImages?: boolean;
    maxUploadedImages?: number;
    retries?: number;
    retryBaseDelayMs?: number;
    logPath?: string;
}
export interface LarkDocumentRef {
    title: string;
    docId?: string;
    docUrl?: string;
    token?: string;
    type?: string;
    exists: boolean;
}
export interface LarkSyncLogEntry {
    timestamp: string;
    action: "search" | "fetch" | "create" | "update" | "retry" | "error" | "complete";
    status: "success" | "failed" | "skipped";
    message: string;
    doc?: LarkDocumentRef;
    attempt?: number;
    durationMs?: number;
}
export interface LarkSyncResult {
    action: "created" | "updated";
    updateMode: LarkUpdateMode;
    document: LarkDocumentRef;
    chunksWritten: number;
    imagesUploaded?: number;
    gifImagesInserted?: number;
    markdownLength: number;
    logPath: string;
    outputMarkdownPath: string;
}

import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { createPreviewHtml } from "./preview.js";
const DEFAULT_BREAKPOINTS = [360, 768, 1024, 1280];
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
const DEFAULT_TIMEOUT_MS = 45_000;
function safeFileName(value) {
    return value.replace(/[^a-z0-9._-]+/gi, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "asset";
}
function imageExtension(url, contentType) {
    if (contentType?.includes("png"))
        return ".png";
    if (contentType?.includes("webp"))
        return ".webp";
    if (contentType?.includes("gif"))
        return ".gif";
    if (contentType?.includes("svg"))
        return ".svg";
    if (contentType?.includes("jpeg") || contentType?.includes("jpg"))
        return ".jpg";
    try {
        const ext = path.extname(new URL(url).pathname);
        return ext || ".img";
    }
    catch {
        return ".img";
    }
}
async function autoScroll(page) {
    await page.evaluate(async () => {
        await new Promise((resolve) => {
            let lastHeight = 0;
            let stableTicks = 0;
            const timer = window.setInterval(() => {
                const height = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
                window.scrollBy(0, Math.max(400, Math.floor(window.innerHeight * 0.75)));
                if (height === lastHeight) {
                    stableTicks += 1;
                }
                else {
                    stableTicks = 0;
                    lastHeight = height;
                }
                if (window.scrollY + window.innerHeight >= height && stableTicks >= 2) {
                    window.clearInterval(timer);
                    window.scrollTo(0, 0);
                    resolve();
                }
            }, 160);
        });
    });
}
async function collectSnapshot(page, includeStyles, includeHtml, maxDepth) {
    const snapshot = await page.evaluate(({ includeStyles: shouldIncludeStyles, includeHtml: shouldIncludeHtml, maxDepth: depthLimit }) => {
        let sequence = 0;
        const skippedTags = new Set(["script", "style", "noscript", "template", "meta", "link"]);
        const blockTags = new Set([
            "article",
            "aside",
            "blockquote",
            "code",
            "dd",
            "details",
            "div",
            "dl",
            "dt",
            "figcaption",
            "figure",
            "footer",
            "h1",
            "h2",
            "h3",
            "h4",
            "h5",
            "h6",
            "header",
            "li",
            "main",
            "nav",
            "ol",
            "p",
            "pre",
            "section",
            "table",
            "tbody",
            "td",
            "th",
            "thead",
            "tr",
            "ul"
        ]);
        function nextId(prefix) {
            sequence += 1;
            return `${prefix}_${sequence}`;
        }
        function bounds(el) {
            const rect = el.getBoundingClientRect();
            return {
                top: Math.round((rect.top + window.scrollY) * 100) / 100,
                left: Math.round((rect.left + window.scrollX) * 100) / 100,
                width: Math.round(rect.width * 100) / 100,
                height: Math.round(rect.height * 100) / 100,
                bottom: Math.round((rect.bottom + window.scrollY) * 100) / 100,
                right: Math.round((rect.right + window.scrollX) * 100) / 100
            };
        }
        function styles(el) {
            if (!shouldIncludeStyles)
                return undefined;
            const computed = window.getComputedStyle(el);
            return {
                fontFamily: computed.fontFamily,
                fontSize: computed.fontSize,
                fontWeight: computed.fontWeight,
                fontStyle: computed.fontStyle,
                lineHeight: computed.lineHeight,
                color: computed.color,
                backgroundColor: computed.backgroundColor,
                textAlign: computed.textAlign,
                textDecoration: computed.textDecoration,
                letterSpacing: computed.letterSpacing,
                display: computed.display,
                position: computed.position,
                margin: computed.margin,
                padding: computed.padding,
                border: computed.border,
                borderRadius: computed.borderRadius,
                objectFit: computed.objectFit,
                objectPosition: computed.objectPosition,
                zIndex: computed.zIndex,
                opacity: computed.opacity
            };
        }
        function attributes(el) {
            return Array.from(el.attributes).reduce((acc, attr) => {
                acc[attr.name] = attr.value;
                return acc;
            }, {});
        }
        function domPath(el) {
            const parts = [];
            let current = el;
            while (current && current.nodeType === Node.ELEMENT_NODE) {
                const parent = current.parentElement;
                const tag = current.tagName.toLowerCase();
                if (!parent) {
                    parts.unshift(tag);
                    break;
                }
                const currentTag = current.tagName;
                const sameTagSiblings = Array.from(parent.children).filter((child) => child.tagName === currentTag);
                const index = sameTagSiblings.indexOf(current) + 1;
                parts.unshift(`${tag}:nth-of-type(${index})`);
                current = parent;
            }
            return parts.join(" > ");
        }
        function visible(el) {
            const computed = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return computed.display !== "none" && computed.visibility !== "hidden" && Number(computed.opacity) !== 0 && (rect.width > 0 || rect.height > 0);
        }
        function normalizeText(value) {
            return value.replace(/\u00a0/g, " ").replace(/[\u200b-\u200d\ufeff]/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
        }
        function blockType(tag) {
            if (/^h[1-6]$/.test(tag))
                return "heading";
            if (tag === "p" || tag === "figcaption")
                return "paragraph";
            if (tag === "ul" || tag === "ol")
                return "list";
            if (tag === "li")
                return "list-item";
            if (tag === "table" || tag === "thead" || tag === "tbody" || tag === "tr" || tag === "td" || tag === "th")
                return "table";
            if (tag === "blockquote")
                return "quote";
            if (tag === "pre" || tag === "code")
                return "code";
            if (tag === "img" || tag === "picture" || tag === "svg")
                return "image";
            if (tag === "iframe" || tag === "video" || tag === "audio")
                return "embed";
            if (tag === "section" || tag === "article" || tag === "main" || tag === "header" || tag === "footer" || tag === "nav" || tag === "aside")
                return "section";
            return "other";
        }
        function isNoiseElement(el) {
            const tag = el.tagName.toLowerCase();
            if (["nav", "header", "footer", "aside"].includes(tag))
                return true;
            const marker = `${el.id} ${el.className} ${el.getAttribute("role") ?? ""}`.toLowerCase();
            return /nav|menu|sidebar|breadcrumb|toc|footer|header|comment|recommend|related|feedback|share|social|login|search/.test(marker);
        }
        function contentScore(el) {
            if (!visible(el) || isNoiseElement(el))
                return -Infinity;
            const text = normalizeText(el.innerText || el.textContent || "");
            const linkText = Array.from(el.querySelectorAll("a")).map((link) => normalizeText(link.textContent ?? "")).join("");
            const linkDensity = text ? linkText.length / text.length : 1;
            const paragraphs = el.querySelectorAll("p,li,blockquote,pre,table").length;
            const headings = el.querySelectorAll("h1,h2,h3,h4,h5,h6").length;
            const images = Array.from(el.querySelectorAll("img,picture,figure")).filter((image) => {
                const rect = image.getBoundingClientRect();
                return rect.width >= 40 && rect.height >= 40;
            }).length;
            const rect = el.getBoundingClientRect();
            const areaBonus = Math.min(rect.width * rect.height, 800_000) / 8_000;
            const roleBonus = /article|main|content|detail|doc|markdown|richtext|help/i.test(`${el.tagName} ${el.id} ${el.className}`) ? 1_500 : 0;
            return text.length + paragraphs * 350 + headings * 250 + images * 180 + areaBonus + roleBonus - linkDensity * 1_800;
        }
        function selectContentRoot() {
            const selectors = [
                "article",
                "main",
                "[role='main']",
                "[class*='article' i]",
                "[class*='content' i]",
                "[class*='detail' i]",
                "[class*='markdown' i]",
                "[class*='richtext' i]",
                ".heraAdit-articleBody",
                ".zone-container.editor-kit-container",
                "[data-testid*='article' i]"
            ];
            const candidates = Array.from(new Set(selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)))));
            const scored = candidates
                .map((el) => ({ el, score: contentScore(el) }))
                .filter((item) => Number.isFinite(item.score))
                .sort((a, b) => b.score - a.score);
            return scored[0]?.score > 800 ? scored[0].el : document.body;
        }
        function markdownEscape(value) {
            return value.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]").replace(/\|/g, "\\|").trim();
        }
        function markdownUrl(value) {
            return value.replace(/\)/g, "%29").replace(/\(/g, "%28");
        }
        function xmlEscape(value) {
            return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br/>").trim();
        }
        function xmlText(value) {
            return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br/>");
        }
        function xmlAttr(value) {
            return xmlEscape(value).replace(/"/g, "&quot;");
        }
        function imageSource(el) {
            if (el instanceof HTMLImageElement)
                return el.currentSrc || el.src || el.getAttribute("data-src") || "";
            const src = el.getAttribute("src") || el.getAttribute("data-src") || "";
            return src ? new URL(src, document.baseURI).href : "";
        }
        function inlineMarkdown(node) {
            if (node.nodeType === Node.TEXT_NODE)
                return (node.textContent ?? "").replace(/[\u200b-\u200d\ufeff]/g, "").replace(/\s+/g, " ");
            if (!(node instanceof Element) || !visible(node) || skippedTags.has(node.tagName.toLowerCase()))
                return "";
            const tag = node.tagName.toLowerCase();
            if (tag === "br")
                return "\n";
            if (tag === "img") {
                const src = imageSource(node);
                if (!src)
                    return "";
                const alt = markdownEscape(node.getAttribute("alt") || node.getAttribute("title") || "图片");
                return `![${alt}](${markdownUrl(src)})`;
            }
            const content = Array.from(node.childNodes).map(inlineMarkdown).join("").replace(/[ \t]{2,}/g, " ").trim();
            if (!content)
                return "";
            if (tag === "a") {
                const href = node.href;
                return href ? `[${content}](${markdownUrl(href)})` : content;
            }
            if (tag === "strong" || tag === "b")
                return `**${content}**`;
            if (tag === "em" || tag === "i")
                return `*${content}*`;
            if (tag === "code")
                return `\`${content.replace(/`/g, "\\`")}\``;
            return content;
        }
        function directInlineMarkdown(el) {
            const nestedBlockTags = new Set(["article", "section", "div", "h1", "h2", "h3", "h4", "h5", "h6", "p", "ul", "ol", "blockquote", "pre", "table", "figure", "img"]);
            return Array.from(el.childNodes)
                .filter((node) => !(node instanceof Element && nestedBlockTags.has(node.tagName.toLowerCase())))
                .map(inlineMarkdown)
                .join("")
                .replace(/[ \t]{2,}/g, " ")
                .trim();
        }
        function renderTable(table) {
            const rows = Array.from(table.querySelectorAll("tr"))
                .map((row) => Array.from(row.querySelectorAll("th,td")).map((cell) => markdownEscape(normalizeText(cell.textContent ?? ""))))
                .filter((cells) => cells.length > 0);
            if (!rows.length)
                return "";
            const width = Math.max(...rows.map((row) => row.length));
            const normalizedRows = rows.map((row) => [...row, ...Array(Math.max(width - row.length, 0)).fill("")]);
            const [head, ...body] = normalizedRows;
            return [`| ${head.join(" | ")} |`, `| ${Array(width).fill("---").join(" | ")} |`, ...body.map((row) => `| ${row.join(" | ")} |`)].join("\n");
        }
        function renderMarkdown(el, listDepth = 0) {
            if (!visible(el) || skippedTags.has(el.tagName.toLowerCase()) || isNoiseElement(el))
                return [];
            const tag = el.tagName.toLowerCase();
            const className = String(el.className || "");
            const blockChildSelector = "h1,h2,h3,h4,h5,h6,p,ul,ol,li,blockquote,pre,table,figure,img";
            if (tag === "div" && className.includes("ace-line")) {
                const text = inlineMarkdown(el);
                if (!text)
                    return [];
                if (className.includes("heading-h2"))
                    return [`## ${text}`];
                if (className.includes("heading-h3"))
                    return [`### ${text}`];
                if (className.includes("heading-h4"))
                    return [`#### ${text}`];
                if (className.includes("list-div") && /(?:^|\s)ol-/.test(className))
                    return [`1. ${text}`];
                if (className.includes("list-div"))
                    return [`- ${text}`];
                return [text];
            }
            if (/^h[1-6]$/.test(tag)) {
                const text = inlineMarkdown(el);
                return text ? [`${"#".repeat(Number(tag.slice(1)))} ${text}`] : [];
            }
            if (tag === "p") {
                const text = inlineMarkdown(el);
                return text ? [text] : [];
            }
            if (tag === "blockquote") {
                const text = inlineMarkdown(el);
                return text ? text.split("\n").map((line) => `> ${line}`) : [];
            }
            if (tag === "pre")
                return [`\`\`\`\n${el.textContent?.trim() ?? ""}\n\`\`\``];
            if (tag === "table")
                return [renderTable(el)].filter(Boolean);
            if (tag === "img") {
                const text = inlineMarkdown(el);
                return text ? [text] : [];
            }
            if (tag === "figure") {
                const parts = Array.from(el.children).flatMap((child) => renderMarkdown(child, listDepth));
                const caption = el.querySelector("figcaption");
                const captionText = caption ? inlineMarkdown(caption) : "";
                return captionText ? [...parts, `*${captionText}*`] : parts;
            }
            if (tag === "ul" || tag === "ol") {
                return Array.from(el.children)
                    .filter((child) => child.tagName.toLowerCase() === "li")
                    .flatMap((li, index) => {
                    const prefix = tag === "ol" ? `${index + 1}.` : "-";
                    const text = directInlineMarkdown(li);
                    const nested = Array.from(li.children)
                        .filter((child) => ["ul", "ol"].includes(child.tagName.toLowerCase()))
                        .flatMap((child) => renderMarkdown(child, listDepth + 1));
                    const indent = "  ".repeat(listDepth);
                    return [text ? `${indent}${prefix} ${text}` : "", ...nested].filter(Boolean);
                });
            }
            if (tag === "figcaption")
                return [];
            if ((tag === "div" || tag === "section") && !el.querySelector(blockChildSelector)) {
                const text = directInlineMarkdown(el);
                if (el.querySelector("a[href]") && text.length < 120)
                    return [];
                return text && text.length > 8 ? [text] : [];
            }
            return Array.from(el.children).flatMap((child) => renderMarkdown(child, listDepth));
        }
        function listMetaFromAceLine(el) {
            const className = String(el.className || "");
            if (!className.includes("list-div"))
                return undefined;
            const listEl = el.querySelector("ol.r-list, ul.r-list, ol[class*='list-'], ul[class*='list-']");
            const listClass = String(listEl?.className || "");
            const level = Number.parseInt(listClass.match(/list-(?:number|bullet|indent)(\d+)/)?.[1] || "1", 10);
            const kind = listClass.includes("list-indent") ? "indent" : listEl ? (listEl.tagName.toLowerCase() === "ol" ? "ol" : "ul") : /(?:^|\s)ol-/.test(className) ? "ol" : "ul";
            const text = inlineLarkXml(el);
            return text ? { kind, level: Number.isFinite(level) ? level : 1, text } : undefined;
        }
        function fallbackAceHeadingTag(el) {
            const className = String(el.className || "");
            // Feishu Help Center ace-line heading classes are one level higher than their visual/article hierarchy.
            if (className.includes("heading-h2"))
                return "h3";
            if (className.includes("heading-h3"))
                return "h4";
            if (className.includes("heading-h4"))
                return "h5";
            return undefined;
        }
        function fontSizePx(el) {
            const value = Number.parseFloat(window.getComputedStyle(el).fontSize || "");
            return Number.isFinite(value) ? value : 0;
        }
        function fontWeightValue(el) {
            const raw = window.getComputedStyle(el).fontWeight;
            if (raw === "bold")
                return 700;
            const value = Number.parseInt(raw, 10);
            return Number.isFinite(value) ? value : 400;
        }
        function median(values) {
            const sorted = values.filter((value) => value > 0).sort((a, b) => a - b);
            if (!sorted.length)
                return 16;
            const middle = Math.floor(sorted.length / 2);
            return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
        }
        function isNumberedChapterTitle(text) {
            return /^[一二三四五六七八九十]+、\S+/.test(text.trim());
        }
        function visualHeadingTag(el, bodyFontSize, text) {
            const className = String(el.className || "");
            if (isNumberedChapterTitle(text))
                return "h2";
            const size = fontSizePx(el);
            const weight = fontWeightValue(el);
            const isHeadingLike = /heading-h\d/.test(className) || /^h[1-6]$/i.test(el.tagName) || weight >= 600;
            if (!isHeadingLike || !size)
                return fallbackAceHeadingTag(el);
            const diff = size - bodyFontSize;
            if (diff >= 10)
                return "h1";
            if (diff >= 7)
                return "h2";
            if (diff >= 4)
                return "h3";
            if (diff >= 2 && weight >= 600)
                return "h4";
            return fallbackAceHeadingTag(el);
        }
        function inlineLarkXml(root) {
            const ignoredInlineTags = new Set(["script", "style", "noscript", "template", "img"]);
            const rootElement = root;
            function hasStyledAncestor(node, predicate) {
                let current = node.parentElement;
                while (current && current !== rootElement.parentElement) {
                    if (predicate(current))
                        return true;
                    if (current === rootElement)
                        break;
                    current = current.parentElement;
                }
                return false;
            }
            function currentLink(node) {
                let current = node.parentElement;
                while (current && current !== rootElement.parentElement) {
                    if (current instanceof HTMLAnchorElement && current.href)
                        return current.href;
                    if (current === rootElement)
                        break;
                    current = current.parentElement;
                }
                return undefined;
            }
            function wrapText(rawText, source) {
                const text = rawText.replace(/[\u200b-\u200d\ufeff]/g, "").replace(/\s+/g, " ");
                if (!text.trim())
                    return "";
                const href = currentLink(source);
                const bold = hasStyledAncestor(source, (el) => {
                    const tag = el.tagName.toLowerCase();
                    const weight = Number.parseInt(window.getComputedStyle(el).fontWeight, 10);
                    return tag === "strong" || tag === "b" || weight >= 600;
                });
                const italic = hasStyledAncestor(source, (el) => {
                    const tag = el.tagName.toLowerCase();
                    return tag === "em" || tag === "i" || window.getComputedStyle(el).fontStyle === "italic";
                });
                const deleted = hasStyledAncestor(source, (el) => {
                    const tag = el.tagName.toLowerCase();
                    return tag === "del" || tag === "s";
                });
                const underline = hasStyledAncestor(source, (el) => {
                    const tag = el.tagName.toLowerCase();
                    return tag === "u" || window.getComputedStyle(el).textDecorationLine.includes("underline");
                });
                const code = hasStyledAncestor(source, (el) => el.tagName.toLowerCase() === "code");
                let content = xmlText(text);
                if (code)
                    content = `<code>${content}</code>`;
                if (underline)
                    content = `<u>${content}</u>`;
                if (deleted)
                    content = `<del>${content}</del>`;
                if (italic)
                    content = `<em>${content}</em>`;
                if (bold)
                    content = `<b>${content}</b>`;
                if (href)
                    content = `<a href="${xmlAttr(href)}">${content}</a>`;
                return content;
            }
            function renderNode(node) {
                if (node.nodeType === Node.TEXT_NODE)
                    return wrapText(node.textContent ?? "", node);
                if (!(node instanceof Element) || !visible(node) || ignoredInlineTags.has(node.tagName.toLowerCase()))
                    return "";
                if (node.tagName.toLowerCase() === "br")
                    return "<br/>";
                return Array.from(node.childNodes).map(renderNode).join("");
            }
            return Array.from(root.childNodes).map(renderNode).join("").replace(/[ \t]{2,}/g, " ").trim();
        }
        function simpleHash(value) {
            let hash = 0;
            for (let index = 0; index < value.length; index += 1) {
                hash = (hash * 31 + value.charCodeAt(index)) | 0;
            }
            return Math.abs(hash).toString(36);
        }
        function isGifImageSource(src) {
            try {
                return /\.gif(?:$|[?#])/i.test(new URL(src, document.baseURI).href);
            }
            catch {
                return /\.gif(?:$|[?#])/i.test(src);
            }
        }
        function cleanImageCaption(value) {
            const text = value?.trim();
            if (!text || text === "图片" || /^GIF 图片\s*\d*$/i.test(text))
                return undefined;
            return text;
        }
        function renderLarkXml(root, title) {
            const parts = [`<title>${xmlEscape(title || document.title || "网页正文")}</title>`];
            const gifAnchors = [];
            const imageXml = (src, caption) => {
                if (isGifImageSource(src)) {
                    const order = gifAnchors.length;
                    const anchor = `__MCP_GIF_ANCHOR_${order + 1}_${simpleHash(src)}__`;
                    gifAnchors.push({ anchor, src: new URL(src, document.baseURI).href, caption, order });
                    return `<p>${anchor}</p>`;
                }
                const captionAttr = caption?.trim() ? ` caption="${xmlAttr(caption)}"` : "";
                return `<img href="${xmlAttr(src)}"${captionAttr}/>`;
            };
            const appendImage = (src, caption) => {
                parts.push(imageXml(src, caption));
            };
            const renderImageRows = (images) => {
                const rows = [];
                for (const img of images.sort((a, b) => {
                    const rectA = a.getBoundingClientRect();
                    const rectB = b.getBoundingClientRect();
                    return Math.abs(rectA.top - rectB.top) > 24 ? rectA.top - rectB.top : rectA.left - rectB.left;
                })) {
                    const rect = img.getBoundingClientRect();
                    const row = rows.find((candidate) => {
                        const first = candidate[0]?.getBoundingClientRect();
                        return first ? Math.abs(first.top - rect.top) <= Math.max(24, Math.min(first.height, rect.height) * 0.35) : false;
                    });
                    if (row)
                        row.push(img);
                    else
                        rows.push([img]);
                }
                return rows.map((row) => {
                    if (row.length === 1) {
                        const img = row[0];
                        return imageXml(imageSource(img), cleanImageCaption(img.getAttribute("alt") || img.getAttribute("title")));
                    }
                    const totalWidth = row.reduce((sum, img) => sum + Math.max(img.getBoundingClientRect().width, 1), 0);
                    const columns = row
                        .map((img) => {
                        const ratio = Math.max(img.getBoundingClientRect().width, 1) / totalWidth;
                        const widthRatio = Math.round(ratio * 1000) / 1000;
                        const content = imageXml(imageSource(img), cleanImageCaption(img.getAttribute("alt") || img.getAttribute("title")));
                        return `<column width-ratio="${widthRatio}">${content}</column>`;
                    })
                        .join("");
                    return `<grid>${columns}</grid>`;
                });
            };
            const aceLines = Array.from(root.querySelectorAll(".ace-line"));
            if (!aceLines.length) {
                for (const line of renderMarkdown(root)) {
                    if (/^###\s+/.test(line))
                        parts.push(`<h3>${xmlEscape(line.replace(/^###\s+/, ""))}</h3>`);
                    else if (/^##\s+/.test(line))
                        parts.push(`<h2>${xmlEscape(line.replace(/^##\s+/, ""))}</h2>`);
                    else if (/^#\s+/.test(line))
                        parts.push(`<h1>${xmlEscape(line.replace(/^#\s+/, ""))}</h1>`);
                    else if (/^-\s+/.test(line))
                        parts.push(`<ul><li>${xmlEscape(line.replace(/^-\s+/, ""))}</li></ul>`);
                    else if (/^\d+\.\s+/.test(line))
                        parts.push(`<ol><li seq="auto">${xmlEscape(line.replace(/^\d+\.\s+/, ""))}</li></ol>`);
                    else if (/^!\[/.test(line)) {
                        const match = line.match(/^!\[([^\]]*)]\((.*)\)$/);
                        if (match)
                            appendImage(match[2], match[1]);
                    }
                    else {
                        parts.push(`<p>${xmlEscape(line)}</p>`);
                    }
                }
                return { xml: parts.join("\n"), gifAnchors };
            }
            const bodyFontSize = median(aceLines
                .filter((el) => {
                const className = String(el.className || "");
                return visible(el) && !className.includes("list-div") && !/heading-h\d/.test(className) && normalizeText(el.textContent || "").length > 12;
            })
                .map(fontSizePx));
            const listGroup = [];
            const renderListBlocks = (blocks, inList = false) => blocks
                .map((block) => {
                if (block.type === "p")
                    return inList ? `<br/>${block.text}` : `<p>${block.text}</p>`;
                const children = block.items
                    .map((item) => {
                    const nested = renderListBlocks(item.children, true);
                    return block.kind === "ol" ? `<li seq="auto">${item.text}${nested}</li>` : `<li>${item.text}${nested}</li>`;
                })
                    .join("");
                return `<${block.kind}>${children}</${block.kind}>`;
            })
                .join("");
            const renderListGroup = (lines) => {
                const root = [];
                const stack = [];
                for (const line of lines) {
                    const level = Math.max(1, line.level);
                    if (line.kind === "indent") {
                        const deeperTarget = stack
                            .slice(level + 1)
                            .reverse()
                            .find(Boolean)?.item;
                        const target = deeperTarget || stack[level]?.item || stack[level - 1]?.item;
                        const paragraph = { type: "p", text: line.text };
                        if (target)
                            target.children.push(paragraph);
                        else
                            root.push(paragraph);
                        continue;
                    }
                    for (let index = level + 1; index < stack.length; index += 1)
                        stack[index] = undefined;
                    const parent = level === 1 ? undefined : stack[level - 1]?.item || stack.slice(1, level).reverse().find(Boolean)?.item;
                    const parentChildren = parent ? parent.children : root;
                    const current = stack[level]?.container;
                    const container = current && current.kind === line.kind && parentChildren[parentChildren.length - 1] === current
                        ? current
                        : { type: "list", kind: line.kind, items: [] };
                    if (parentChildren[parentChildren.length - 1] !== container)
                        parentChildren.push(container);
                    const item = { text: line.text, children: [] };
                    container.items.push(item);
                    stack[level] = { container, item };
                }
                return renderListBlocks(root);
            };
            const flushListGroup = () => {
                if (!listGroup.length)
                    return;
                parts.push(renderListGroup(listGroup));
                listGroup.length = 0;
            };
            for (const el of aceLines) {
                if (!visible(el) || isNoiseElement(el))
                    continue;
                const className = String(el.className || "");
                if (className.includes("ace-line-image-wrapper")) {
                    flushListGroup();
                    const images = Array.from(el.querySelectorAll("img")).filter((img) => Boolean(imageSource(img)));
                    parts.push(...renderImageRows(images));
                    continue;
                }
                const text = inlineLarkXml(el);
                if (!text)
                    continue;
                const listMeta = listMetaFromAceLine(el);
                if (listMeta) {
                    listGroup.push(listMeta);
                    continue;
                }
                flushListGroup();
                const headingTag = visualHeadingTag(el, bodyFontSize, el.textContent || "");
                if (headingTag)
                    parts.push(`<${headingTag}>${text}</${headingTag}>`);
                else
                    parts.push(`<p>${text}</p>`);
            }
            flushListGroup();
            return { xml: parts.join("\n"), gifAnchors };
        }
        function inlineRuns(el) {
            const runs = [];
            const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
                acceptNode(node) {
                    if (!node.textContent?.trim())
                        return NodeFilter.FILTER_REJECT;
                    const parent = node.parentElement;
                    if (!parent || skippedTags.has(parent.tagName.toLowerCase()))
                        return NodeFilter.FILTER_REJECT;
                    return NodeFilter.FILTER_ACCEPT;
                }
            });
            while (walker.nextNode()) {
                const node = walker.currentNode;
                const parent = node.parentElement;
                if (!parent)
                    continue;
                const tag = parent.tagName.toLowerCase();
                const ancestorLink = parent.closest("a");
                const computed = window.getComputedStyle(parent);
                runs.push({
                    text: node.textContent ?? "",
                    tag,
                    href: ancestorLink instanceof HTMLAnchorElement ? ancestorLink.href : undefined,
                    styles: styles(parent),
                    semantic: {
                        bold: tag === "strong" || tag === "b" || Number.parseInt(computed.fontWeight, 10) >= 600,
                        italic: tag === "i" || tag === "em" || computed.fontStyle === "italic",
                        underline: computed.textDecorationLine.includes("underline"),
                        link: Boolean(ancestorLink),
                        code: tag === "code" || Boolean(parent.closest("code,pre"))
                    }
                });
            }
            return runs;
        }
        function nearbyText(el, direction) {
            const sibling = direction === "previous" ? el.previousElementSibling : el.nextElementSibling;
            const text = sibling?.textContent ? normalizeText(sibling.textContent) : "";
            return text ? text.slice(0, 240) : undefined;
        }
        function captionFor(el) {
            const figure = el.closest("figure");
            const figcaption = figure?.querySelector("figcaption");
            const aria = el.getAttribute("aria-label") || el.getAttribute("aria-describedby");
            const text = figcaption?.textContent ? normalizeText(figcaption.textContent) : aria ?? "";
            return text || undefined;
        }
        function imageFromElement(el, kind, src) {
            const image = el instanceof HTMLImageElement ? el : undefined;
            const parent = el.parentElement;
            const order = Array.from(document.body.querySelectorAll("*")).indexOf(el);
            return {
                id: nextId("img"),
                kind,
                src,
                absoluteUrl: new URL(src, document.baseURI).href,
                srcset: image?.srcset || el.getAttribute("srcset") || undefined,
                sizes: image?.sizes || el.getAttribute("sizes") || undefined,
                alt: image?.alt || el.getAttribute("alt") || undefined,
                title: el.getAttribute("title") || undefined,
                ariaLabel: el.getAttribute("aria-label") || undefined,
                caption: captionFor(el),
                bounds: bounds(el),
                naturalSize: image ? { width: image.naturalWidth, height: image.naturalHeight } : undefined,
                layoutRelation: {
                    parentPath: parent ? domPath(parent) : "",
                    previousText: nearbyText(el, "previous"),
                    nextText: nearbyText(el, "next"),
                    order
                },
                styles: styles(el),
                attributes: attributes(el)
            };
        }
        function meaningfulImage(el, kind) {
            const rect = el.getBoundingClientRect();
            if (kind === "svg" && (rect.width < 48 || rect.height < 48))
                return false;
            if (kind === "background" && (rect.width < 80 || rect.height < 80))
                return false;
            if (rect.width < 24 || rect.height < 24)
                return false;
            const marker = `${el.id} ${el.className} ${el.getAttribute("aria-label") ?? ""}`.toLowerCase();
            return !/icon|avatar|logo|social|close|button|sprite/.test(marker) || rect.width >= 120 || rect.height >= 120;
        }
        function blockFromElement(el, depth) {
            const tag = el.tagName.toLowerCase();
            if (skippedTags.has(tag) || !visible(el))
                return null;
            if (!blockTags.has(tag) && tag !== "img" && tag !== "iframe" && tag !== "video" && tag !== "audio")
                return null;
            const text = normalizeText(el.textContent ?? "");
            const type = blockType(tag);
            if (type !== "image" && type !== "embed" && !text)
                return null;
            const attrs = attributes(el);
            const block = {
                id: nextId("block"),
                type,
                tag,
                depth,
                domPath: domPath(el),
                text: type === "image" ? undefined : text,
                html: shouldIncludeHtml ? el.outerHTML.slice(0, 50_000) : undefined,
                bounds: bounds(el),
                styles: styles(el),
                attributes: attrs,
                inlines: type === "image" ? [] : inlineRuns(el)
            };
            if (el instanceof HTMLImageElement) {
                block.imageRef = el.currentSrc || el.src;
            }
            if (type === "list") {
                block.children = Array.from(el.children)
                    .filter((child) => child.tagName.toLowerCase() === "li")
                    .map((child) => blockFromElement(child, depth + 1))
                    .filter(Boolean);
            }
            return block;
        }
        function buildDomTree(node, depth = 0) {
            const tag = node.tagName.toLowerCase();
            if (skippedTags.has(tag) || depth > depthLimit)
                return null;
            return {
                id: nextId("dom"),
                tag,
                type: "element",
                depth,
                domPath: domPath(node),
                text: normalizeText(node.childNodes.length === 1 ? node.textContent ?? "" : ""),
                bounds: visible(node) ? bounds(node) : undefined,
                styles: visible(node) ? styles(node) : undefined,
                attributes: attributes(node),
                children: Array.from(node.children)
                    .map((child) => buildDomTree(child, depth + 1))
                    .filter(Boolean)
            };
        }
        const contentRoot = selectContentRoot();
        const blocks = [];
        const images = [];
        const walker = document.createTreeWalker(contentRoot, NodeFilter.SHOW_ELEMENT);
        while (walker.nextNode()) {
            const el = walker.currentNode;
            const tag = el.tagName.toLowerCase();
            const depth = domPath(el).split(">").length - 1;
            const block = blockFromElement(el, depth);
            if (block)
                blocks.push(block);
            if (isNoiseElement(el))
                continue;
            if (el instanceof HTMLImageElement && (el.currentSrc || el.src) && meaningfulImage(el, "img")) {
                images.push(imageFromElement(el, "img", el.currentSrc || el.src));
            }
            if (el instanceof HTMLVideoElement && el.poster && meaningfulImage(el, "video-poster")) {
                images.push(imageFromElement(el, "video-poster", el.poster));
            }
            if (tag === "svg" && meaningfulImage(el, "svg")) {
                images.push(imageFromElement(el, "svg", `data:image/svg+xml;charset=utf-8,${encodeURIComponent(el.outerHTML)}`));
            }
            const background = window.getComputedStyle(el).backgroundImage;
            const urls = Array.from(background.matchAll(/url\((['"]?)(.*?)\1\)/g)).map((match) => match[2]).filter(Boolean);
            for (const url of urls) {
                if (meaningfulImage(el, "background")) {
                    images.push(imageFromElement(el, "background", url));
                }
            }
        }
        blocks.sort((a, b) => {
            const ba = a.bounds;
            const bb = b.bounds;
            return ba.top === bb.top ? ba.left - bb.left : ba.top - bb.top;
        });
        images.sort((a, b) => {
            const ba = a.bounds;
            const bb = b.bounds;
            return ba.top === bb.top ? ba.left - bb.left : ba.top - bb.top;
        });
        const links = Array.from(contentRoot.querySelectorAll("a[href]")).map((link) => ({
            text: normalizeText(link.textContent ?? ""),
            href: link.href,
            domPath: domPath(link)
        }));
        const headings = blocks.filter((block) => block.type === "heading");
        const rawMarkdown = renderMarkdown(contentRoot)
            .filter(Boolean)
            .join("\n\n");
        const firstTitleIndex = rawMarkdown.search(/^#\s+/m);
        const markdown = firstTitleIndex > 0 ? rawMarkdown.slice(firstTitleIndex).trim() : rawMarkdown;
        const larkXmlResult = renderLarkXml(contentRoot, document.title || String(headings[0]?.text ?? "") || "网页正文");
        const stylesheets = Array.from(document.styleSheets).map((sheet) => {
            try {
                const rules = Array.from(sheet.cssRules ?? [])
                    .slice(0, 200)
                    .map((rule) => rule.cssText)
                    .join("\n");
                return { href: sheet.href, text: rules.slice(0, 40_000), disabled: sheet.disabled };
            }
            catch {
                return { href: sheet.href, disabled: sheet.disabled };
            }
        });
        return {
            pageSize: {
                width: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
                height: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)
            },
            blocks,
            images,
            domTree: buildDomTree(contentRoot),
            plainText: normalizeText(markdown
                .replace(/!\[[^\]]*]\([^)]*\)/g, "")
                .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
                .replace(/^#{1,6}\s+/gm, "")
                .replace(/^[-*]\s+/gm, "")
                .replace(/^\d+\.\s+/gm, "")),
            markdown,
            larkXml: larkXmlResult.xml,
            gifAnchors: larkXmlResult.gifAnchors,
            headings,
            links,
            stylesheets,
            inlineStyleCount: document.querySelectorAll("[style]").length
        };
    }, { includeStyles, includeHtml, maxDepth });
    return snapshot;
}
function dedupeImages(images) {
    const seen = new Map();
    for (const image of images) {
        const key = `${image.kind}:${image.absoluteUrl}`;
        if (!seen.has(key)) {
            seen.set(key, image);
        }
    }
    return Array.from(seen.values()).map((image, index) => ({
        ...image,
        id: `img_${index + 1}`,
        layoutRelation: { ...image.layoutRelation, order: index }
    }));
}
function xmlAttributeValue(value) {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br/>").replace(/"/g, "&quot;").trim();
}
function decodeXmlAttribute(value) {
    return value.replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function isGifPathOrUrl(value) {
    if (!value)
        return false;
    return /\.gif(?:$|[?#])/i.test(value);
}
function cleanDefaultImageCaption(value) {
    const text = value?.trim();
    if (!text || text === "图片" || /^GIF 图片\s*\d*$/i.test(text))
        return undefined;
    return text;
}
function applyGifAnchorsFromCachedImages(xml, existingAnchors, images) {
    if (!xml)
        return { xml, gifAnchors: existingAnchors };
    let result = xml;
    const gifAnchors = [...(existingAnchors ?? [])];
    const alreadyAnchored = new Set(gifAnchors.map((anchor) => anchor.src));
    for (const image of images) {
        if (alreadyAnchored.has(image.absoluteUrl) || (!isGifPathOrUrl(image.localPath) && !isGifPathOrUrl(image.absoluteUrl)))
            continue;
        const href = xmlAttributeValue(image.absoluteUrl);
        const imageTagPattern = new RegExp(`<img\\b(?=[^>]*\\bhref="${escapeRegExp(href)}")[^>]*/>`, "i");
        const match = result.match(imageTagPattern);
        if (!match)
            continue;
        const order = gifAnchors.length;
        const anchor = `__MCP_GIF_ANCHOR_${order + 1}_${crypto.createHash("sha1").update(image.absoluteUrl).digest("hex").slice(0, 8)}__`;
        const caption = cleanDefaultImageCaption(decodeXmlAttribute(match[0].match(/\bcaption="([^"]*)"/)?.[1] ?? image.caption ?? image.alt ?? image.title ?? ""));
        gifAnchors.push({ anchor, src: image.absoluteUrl, caption, order });
        alreadyAnchored.add(image.absoluteUrl);
        result = result.replace(imageTagPattern, `<p>${anchor}</p>`);
    }
    return { xml: result, gifAnchors };
}
async function cacheImages(browser, outputDir, images) {
    if (images.length === 0) {
        return undefined;
    }
    const imageDir = path.join(outputDir, "images");
    await mkdir(imageDir, { recursive: true });
    const context = await browser.newContext();
    await Promise.all(images.map(async (image, index) => {
        if (image.absoluteUrl.startsWith("data:")) {
            return;
        }
        try {
            const response = await context.request.get(image.absoluteUrl, { timeout: 20_000 });
            if (!response.ok())
                return;
            const contentType = response.headers()["content-type"];
            const ext = imageExtension(image.absoluteUrl, contentType);
            const base = safeFileName(`${index + 1}_${new URL(image.absoluteUrl).hostname}_${path.basename(new URL(image.absoluteUrl).pathname, ext)}`);
            const fileName = `${base}${ext}`;
            const absolutePath = path.join(imageDir, fileName);
            await writeFile(absolutePath, await response.body());
            image.localPath = path.relative(outputDir, absolutePath);
        }
        catch {
            // Some sites block direct resource requests; keep the original URL in that case.
        }
    }));
    await context.close();
    return imageDir;
}
function updatePreviewImageRefs(data) {
    const byUrl = new Map(data.images.map((image) => [image.absoluteUrl, image.localPath ?? image.absoluteUrl]));
    for (const layout of data.layouts) {
        for (const block of layout.blocks) {
            if (block.type === "image" && block.imageRef) {
                block.imageRef = byUrl.get(block.imageRef) ?? block.imageRef;
            }
        }
    }
}
function normalizeWaitUntil(waitUntil) {
    return waitUntil ?? "networkidle";
}
export async function extractWebpage(options) {
    const outputDir = path.resolve(options.outputDir ?? "output");
    const viewport = options.viewport ?? DEFAULT_VIEWPORT;
    const breakpoints = options.breakpoints?.length ? options.breakpoints : DEFAULT_BREAKPOINTS;
    const includeStyles = options.includeStyles ?? true;
    const includeHtml = options.includeHtml ?? true;
    const includeDynamicContent = options.includeDynamicContent ?? true;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxDepth = options.maxDepth ?? 20;
    await mkdir(outputDir, { recursive: true });
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
        viewport,
        userAgent: options.userAgent
    });
    page.setDefaultTimeout(timeoutMs);
    page.setDefaultNavigationTimeout(timeoutMs);
    const layouts = [];
    const allImages = [];
    let primarySnapshot;
    try {
        for (const breakpoint of breakpoints) {
            const currentViewport = { width: breakpoint, height: viewport.height };
            await page.setViewportSize(currentViewport);
            await page.goto(options.url, { waitUntil: normalizeWaitUntil(options.waitUntil), timeout: timeoutMs });
            if (includeDynamicContent) {
                await autoScroll(page);
                await page.waitForLoadState("networkidle", { timeout: Math.min(timeoutMs, 15_000) }).catch(() => undefined);
            }
            const snapshot = await collectSnapshot(page, includeStyles, includeHtml, maxDepth);
            primarySnapshot = breakpoint === viewport.width || !primarySnapshot ? snapshot : primarySnapshot;
            allImages.push(...snapshot.images);
            layouts.push({
                breakpoint,
                viewport: currentViewport,
                pageSize: snapshot.pageSize,
                blocks: snapshot.blocks,
                domTree: snapshot.domTree
            });
        }
        const finalUrl = page.url();
        const title = await page.title();
        const metaDescription = await page.locator('meta[name="description"]').getAttribute("content").catch(() => "");
        const lang = await page.evaluate(() => document.documentElement.lang || "");
        const images = dedupeImages(allImages);
        const imageDirectory = options.cacheImages === false ? undefined : await cacheImages(browser, outputDir, images);
        const larkXmlWithGifAnchors = applyGifAnchorsFromCachedImages(primarySnapshot?.larkXml, primarySnapshot?.gifAnchors, images);
        const data = {
            meta: {
                title,
                url: options.url,
                finalUrl,
                lang,
                description: metaDescription ?? "",
                collectedAt: new Date().toISOString(),
                viewport,
                breakpoints
            },
            text: {
                plainText: primarySnapshot?.plainText ?? "",
                markdown: primarySnapshot?.markdown ?? "",
                larkXml: larkXmlWithGifAnchors.xml,
                gifAnchors: larkXmlWithGifAnchors.gifAnchors,
                headings: primarySnapshot?.headings ?? [],
                links: primarySnapshot?.links ?? []
            },
            images,
            layouts,
            styles: {
                stylesheets: primarySnapshot?.stylesheets ?? [],
                inlineStyleCount: primarySnapshot?.inlineStyleCount ?? 0
            },
            output: {
                jsonPath: path.join(outputDir, "webpage.json"),
                previewPath: path.join(outputDir, "preview.html"),
                imageDirectory
            }
        };
        updatePreviewImageRefs(data);
        await writeFile(data.output.jsonPath, JSON.stringify(data, null, 2), "utf8");
        await writeFile(data.output.previewPath, createPreviewHtml(data), "utf8");
        return data;
    }
    finally {
        await browser.close();
    }
}
export function createRunId(url) {
    return crypto.createHash("sha1").update(`${url}:${Date.now()}`).digest("hex").slice(0, 10);
}
//# sourceMappingURL=extractor.js.map
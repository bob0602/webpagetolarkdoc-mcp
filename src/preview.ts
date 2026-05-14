import type { ContentBlock, StyleSummary, WebpageExtraction } from "./types.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function styleObjectToCss(styles: StyleSummary | undefined): string {
  if (!styles) {
    return "";
  }

  const propertyMap: Record<string, string> = {
    fontFamily: "font-family",
    fontSize: "font-size",
    fontWeight: "font-weight",
    fontStyle: "font-style",
    lineHeight: "line-height",
    color: "color",
    backgroundColor: "background-color",
    textAlign: "text-align",
    textDecoration: "text-decoration",
    letterSpacing: "letter-spacing",
    display: "display",
    position: "position",
    margin: "margin",
    padding: "padding",
    border: "border",
    borderRadius: "border-radius",
    objectFit: "object-fit",
    objectPosition: "object-position",
    zIndex: "z-index",
    opacity: "opacity"
  };

  return Object.entries(styles)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${propertyMap[key] ?? key}:${value}`)
    .join(";");
}

function renderInline(block: ContentBlock): string {
  if (!block.inlines?.length) {
    return escapeHtml(block.text ?? "");
  }

  return block.inlines
    .map((run) => {
      const css = styleObjectToCss(run.styles);
      const text = escapeHtml(run.text);
      if (run.href) {
        return `<a href="${escapeHtml(run.href)}" style="${escapeHtml(css)}">${text}</a>`;
      }
      return `<span style="${escapeHtml(css)}">${text}</span>`;
    })
    .join("");
}

function renderBlock(block: ContentBlock, baseLayoutWidth: number): string {
  const css = styleObjectToCss(block.styles);
  const commonAttrs = `data-block-id="${escapeHtml(block.id)}" data-dom-path="${escapeHtml(block.domPath)}"`;
  const widthPercent = baseLayoutWidth > 0 ? Math.min(100, (block.bounds.width / baseLayoutWidth) * 100) : 100;
  const frameStyle = `--block-left:${block.bounds.left}px;--block-top:${block.bounds.top}px;max-width:${Math.max(1, widthPercent)}%;`;

  if (block.type === "image" && block.imageRef) {
    return `<figure class="block block-image" style="${escapeHtml(frameStyle)}" ${commonAttrs}>
      <img src="${escapeHtml(block.imageRef)}" alt="${escapeHtml(block.attributes?.alt ?? "")}" style="${escapeHtml(css)}">
      ${block.attributes?.caption ? `<figcaption>${escapeHtml(block.attributes.caption)}</figcaption>` : ""}
    </figure>`;
  }

  if (block.type === "heading") {
    const level = /^h[1-6]$/.test(block.tag) ? block.tag : "h2";
    return `<${level} class="block" style="${escapeHtml(`${frameStyle}${css}`)}" ${commonAttrs}>${renderInline(block)}</${level}>`;
  }

  if (block.type === "list" || block.tag === "ul" || block.tag === "ol") {
    const tag = block.tag === "ol" ? "ol" : "ul";
    const items = block.children?.length
      ? block.children.map((child) => `<li>${renderInline(child)}</li>`).join("")
      : `<li>${escapeHtml(block.text ?? "")}</li>`;
    return `<${tag} class="block" style="${escapeHtml(`${frameStyle}${css}`)}" ${commonAttrs}>${items}</${tag}>`;
  }

  if (block.type === "quote") {
    return `<blockquote class="block" style="${escapeHtml(`${frameStyle}${css}`)}" ${commonAttrs}>${renderInline(block)}</blockquote>`;
  }

  if (block.type === "code") {
    return `<pre class="block" style="${escapeHtml(`${frameStyle}${css}`)}" ${commonAttrs}><code>${escapeHtml(block.text ?? "")}</code></pre>`;
  }

  const tag = block.tag === "div" || block.tag === "span" ? "p" : block.tag || "p";
  return `<${tag} class="block" style="${escapeHtml(`${frameStyle}${css}`)}" ${commonAttrs}>${renderInline(block)}</${tag}>`;
}

export function createPreviewHtml(data: WebpageExtraction): string {
  const layout = data.layouts.at(-1) ?? data.layouts[0];
  const blocks = layout?.blocks ?? [];
  const pageWidth = layout?.pageSize.width ?? data.meta.viewport.width;

  return `<!doctype html>
<html lang="${escapeHtml(data.meta.lang || "zh-CN")}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(data.meta.title || "网页内容预览")}</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #f6f7f9; color: #1f2329; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .toolbar { position: sticky; top: 0; z-index: 10; display: flex; gap: 12px; align-items: center; padding: 12px 16px; background: rgba(255,255,255,.94); border-bottom: 1px solid #dee0e3; backdrop-filter: blur(8px); }
    .toolbar button { border: 1px solid #c9cdd4; border-radius: 6px; background: #fff; padding: 6px 10px; cursor: pointer; }
    .toolbar input { width: 260px; max-width: 40vw; padding: 7px 10px; border: 1px solid #c9cdd4; border-radius: 6px; }
    .summary { color: #646a73; font-size: 13px; }
    .viewport { transform-origin: top center; transition: transform .16s ease; }
    .page { width: min(100%, ${pageWidth}px); margin: 24px auto; padding: 32px; background: #fff; border: 1px solid #dee0e3; border-radius: 10px; box-shadow: 0 8px 30px rgba(31,35,41,.08); }
    .source { margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid #eff0f1; }
    .source h1 { margin: 0 0 8px; font-size: 24px; }
    .source a { color: #1456f0; word-break: break-all; }
    .block { scroll-margin-top: 72px; overflow-wrap: anywhere; }
    .block:hover { outline: 2px solid rgba(20, 86, 240, .28); outline-offset: 3px; }
    .block-image { margin: 16px 0; }
    .block-image img { max-width: 100%; height: auto; display: block; }
    .block-image figcaption { margin-top: 6px; color: #646a73; font-size: 13px; }
    .selected { outline: 3px solid #1456f0 !important; outline-offset: 4px; }
  </style>
</head>
<body>
  <div class="toolbar">
    <button type="button" data-zoom="-0.1">缩小</button>
    <button type="button" data-zoom="0.1">放大</button>
    <button type="button" id="resetZoom">重置</button>
    <input id="locator" placeholder="输入 block id 或文本定位">
    <span class="summary">文本块 ${blocks.length} 个，图片 ${data.images.length} 张</span>
  </div>
  <main class="viewport" id="viewport">
    <article class="page">
      <section class="source">
        <h1>${escapeHtml(data.meta.title || "未命名网页")}</h1>
        <a href="${escapeHtml(data.meta.finalUrl)}">${escapeHtml(data.meta.finalUrl)}</a>
      </section>
      ${blocks.map((block) => renderBlock(block, pageWidth)).join("\n")}
    </article>
  </main>
  <script>
    let scale = 1;
    const viewport = document.getElementById('viewport');
    document.querySelectorAll('[data-zoom]').forEach((button) => {
      button.addEventListener('click', () => {
        scale = Math.max(0.4, Math.min(2.5, scale + Number(button.dataset.zoom)));
        viewport.style.transform = 'scale(' + scale + ')';
      });
    });
    document.getElementById('resetZoom').addEventListener('click', () => {
      scale = 1;
      viewport.style.transform = 'scale(1)';
    });
    document.getElementById('locator').addEventListener('change', (event) => {
      const query = event.target.value.trim().toLowerCase();
      document.querySelectorAll('.selected').forEach((el) => el.classList.remove('selected'));
      if (!query) return;
      const target = Array.from(document.querySelectorAll('.block')).find((el) =>
        el.dataset.blockId?.toLowerCase() === query || el.textContent.toLowerCase().includes(query)
      );
      if (target) {
        target.classList.add('selected');
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  </script>
</body>
</html>`;
}

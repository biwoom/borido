import MarkdownIt from "markdown-it";
import footnote from "markdown-it-footnote";
import sanitizeHtml from "sanitize-html";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MANUAL_ANCHOR = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const INTERNAL_REFERENCE = /^(doc|asset):([^#]+)(?:#(.+))?$/u;

const SANITIZE_OPTIONS = Object.freeze({
  allowedTags: [
    "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6",
    "blockquote", "ul", "ol", "li", "table", "thead", "tbody", "tr",
    "th", "td", "pre", "code", "em", "strong", "s", "del", "a",
    "img", "section", "sup",
  ],
  allowedAttributes: {
    a: ["href", "title", "id", "class"],
    code: ["class"],
    h1: ["id"], h2: ["id"], h3: ["id"], h4: ["id"], h5: ["id"], h6: ["id"],
    hr: ["class"], img: ["src", "alt", "title"], li: ["id", "class"],
    ol: ["class"], section: ["class"], sup: ["class"],
    th: ["style"], td: ["style"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  allowProtocolRelative: false,
  allowedStyles: {
    th: { "text-align": [/^(?:left|right|center)$/u] },
    td: { "text-align": [/^(?:left|right|center)$/u] },
  },
});

function problem({ level = "error", code, message, details = {} }) {
  return { level, code, message, details };
}

function stripCodeSpans(line) {
  let result = "";
  let delimiter = 0;
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] !== "`") {
      result += delimiter === 0 ? line[index] : " ";
      continue;
    }
    let count = 1;
    while (line[index + count] === "`") count += 1;
    if (delimiter === 0) delimiter = count;
    else if (delimiter === count) delimiter = 0;
    result += " ".repeat(count);
    index += count - 1;
  }
  return result;
}

function inspectFootnotes(source) {
  const diagnostics = [];
  const definitions = new Map();
  const references = [];
  const definitionRanges = [];
  const lines = source.split(/\r?\n/u);
  let fence = null;
  let activeDefinition = null;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/u.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      activeDefinition = null;
      continue;
    }
    if (fence !== null) continue;

    const definition = /^\s{0,3}\[\^([^\]\s]+)\]:\s*(.*)$/u.exec(line);
    if (definition) {
      const [, label, body] = definition;
      if (definitions.has(label)) {
        diagnostics.push(problem({
          code: "FOOTNOTE_DEFINITION_DUPLICATE",
          message: "같은 각주 정의를 두 번 사용할 수 없습니다.",
          details: { label, lines: [definitions.get(label), lineIndex + 1] },
        }));
      } else {
        definitions.set(label, lineIndex + 1);
      }
      activeDefinition = { label, start: lineIndex + 1, text: body };
      definitionRanges.push(activeDefinition);
      continue;
    }
    if (activeDefinition && (/^\s{2,}\S/u.test(line) || line.trim() === "")) {
      activeDefinition.text += `\n${line}`;
    } else {
      activeDefinition = null;
    }

    const visible = stripCodeSpans(line);
    if (/\^\[[^\]]+\]/u.test(visible)) {
      diagnostics.push(problem({
        code: "INLINE_FOOTNOTE_UNSUPPORTED",
        message: "인라인 각주는 지원하지 않습니다. 이름 있는 각주 정의를 사용하세요.",
        details: { line: lineIndex + 1 },
      }));
    }
    for (const match of visible.matchAll(/\[\^([^\]\s]+)\]/gu)) {
      references.push({ label: match[1], line: lineIndex + 1 });
    }
  }

  for (const definition of definitionRanges) {
    const nested = [...stripCodeSpans(definition.text).matchAll(/\[\^([^\]\s]+)\]/gu)];
    if (nested.length > 0) {
      diagnostics.push(problem({
        code: "NESTED_FOOTNOTE_UNSUPPORTED",
        message: "각주 정의 안에서 다른 각주를 참조할 수 없습니다.",
        details: { label: definition.label, nested: nested.map((item) => item[1]) },
      }));
    }
  }

  const used = new Set(references.map((item) => item.label));
  for (const reference of references) {
    if (!definitions.has(reference.label)) {
      diagnostics.push(problem({
        code: "FOOTNOTE_DEFINITION_MISSING",
        message: "참조한 각주 정의가 없습니다.",
        details: reference,
      }));
    }
  }
  for (const [label, line] of definitions) {
    if (!used.has(label)) {
      diagnostics.push(problem({
        level: "warning",
        code: "FOOTNOTE_DEFINITION_UNUSED",
        message: "참조되지 않은 각주 정의가 있습니다.",
        details: { label, line },
      }));
    }
  }
  return diagnostics;
}

function inlineText(token) {
  return (token.children ?? [])
    .filter((child) => ["text", "code_inline", "image"].includes(child.type))
    .map((child) => child.content)
    .join("")
    .trim();
}

export function automaticAnchor(value) {
  const anchor = value
    .normalize("NFC")
    .toLocaleLowerCase("und")
    .replace(/[\s_]+/gu, "-")
    .replace(/[^\p{Letter}\p{Number}\p{Mark}-]+/gu, "")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "");
  return anchor || "section";
}

function prepareHeadings(md, tokens, env, diagnostics) {
  const headings = [];
  const manualIds = new Map();
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].type !== "heading_open") continue;
    const inline = tokens[index + 1];
    const marker = /\s+\{#([^{}]+)\}\s*$/u.exec(inline.content);
    const manual = marker?.[1] ?? null;
    if (manual && !MANUAL_ANCHOR.test(manual)) {
      diagnostics.push(problem({
        code: "HEADING_ANCHOR_INVALID",
        message: "수동 제목 앵커는 소문자 영문·숫자·하이픈 형식이어야 합니다.",
        details: { anchor: manual, line: tokens[index].map?.[0] + 1 },
      }));
    } else if (manual) {
      if (manualIds.has(manual)) {
        diagnostics.push(problem({
          code: "HEADING_ANCHOR_DUPLICATE",
          message: "수동 제목 앵커가 중복되었습니다.",
          details: { anchor: manual, lines: [manualIds.get(manual), tokens[index].map?.[0] + 1] },
        }));
      } else {
        manualIds.set(manual, tokens[index].map?.[0] + 1);
      }
      inline.content = inline.content.slice(0, marker.index).trimEnd();
      inline.children = [];
      md.inline.parse(inline.content, md, env, inline.children);
    }
    headings.push({ open: tokens[index], inline, manual: manual && MANUAL_ANCHOR.test(manual) ? manual : null });
  }

  const used = new Set(manualIds.keys());
  const toc = [];
  for (const heading of headings) {
    const text = inlineText(heading.inline);
    let id = heading.manual;
    if (!id) {
      const base = automaticAnchor(text);
      id = base;
      let suffix = 2;
      while (used.has(id)) {
        id = `${base}-${suffix}`;
        suffix += 1;
      }
      used.add(id);
    }
    heading.open.attrSet("id", id);
    const level = Number(heading.open.tag.slice(1));
    if (level === 1) {
      diagnostics.push(problem({
        level: "warning",
        code: "MARKDOWN_H1_PRESENT",
        message: "페이지 제목은 메타데이터를 사용하므로 본문은 H2부터 시작하는 것을 권장합니다.",
        details: { id },
      }));
    }
    toc.push({ level, id, text });
  }
  return { toc, anchors: [...used] };
}

function parseInternalReference(value) {
  const match = INTERNAL_REFERENCE.exec(value);
  if (!match) return null;
  const [, kind, id, encodedAnchor = null] = match;
  let anchor = encodedAnchor;
  try {
    if (anchor !== null) anchor = decodeURIComponent(anchor);
  } catch {
    return { kind, invalid: true, id, anchor };
  }
  if (!UUID_V4.test(id)) return { kind, invalid: true, id, anchor };
  return { kind, id: id.toLowerCase(), anchor };
}

function safeExternalUrl(value) {
  if (value.startsWith("#") || value.startsWith("/")) return !value.startsWith("//");
  return /^(?:https?:|mailto:)/iu.test(value);
}

function walkTokens(tokens, visit) {
  for (const token of tokens) {
    visit(token);
    if (token.children) walkTokens(token.children, visit);
  }
}

function removeRawHtml(tokens, diagnostics) {
  walkTokens(tokens, (token) => {
    if (!["html_block", "html_inline"].includes(token.type)) return;
    diagnostics.push(problem({
      code: "RAW_HTML_UNSUPPORTED",
      message: "원본 HTML은 지원하지 않습니다. Markdown 문법을 사용하세요.",
    }));
    token.content = "";
  });
}

function resolveReferences(tokens, options, diagnostics) {
  const references = [];
  walkTokens(tokens, (token) => {
    const attribute = token.type === "image" ? "src" : token.type === "link_open" ? "href" : null;
    if (!attribute) return;
    const raw = token.attrGet(attribute);
    const internal = parseInternalReference(raw);
    if (internal) {
      const context = token.type === "image" ? "image" : "link";
      references.push({ ...internal, context, source: raw });
      if (internal.invalid || (internal.kind === "doc" && context === "image") || (internal.kind === "asset" && internal.anchor)) {
        diagnostics.push(problem({
          code: "INTERNAL_REFERENCE_INVALID",
          message: "내부 문서/자산 참조 형식이 유효하지 않습니다.",
          details: { source: raw, context },
        }));
        token.attrSet(attribute, "");
        return;
      }
      const resolver = internal.kind === "doc" ? options.resolveDocument : options.resolveAsset;
      const resolved = resolver?.(internal);
      if (!resolved?.ok || typeof resolved.url !== "string") {
        diagnostics.push(problem({
          code: resolved?.code ?? "INTERNAL_REFERENCE_UNRESOLVED",
          message: resolved?.message ?? "내부 참조를 공개 주소로 해석하지 못했습니다.",
          details: { source: raw, ...(resolved?.details ?? {}) },
        }));
        token.attrSet(attribute, "");
      } else {
        token.attrSet(attribute, resolved.url);
      }
      return;
    }
    if (token.type === "image") {
      diagnostics.push(problem({
        code: "EXTERNAL_IMAGE_UNSUPPORTED",
        message: "사용자 이미지는 asset:UUID 참조로 등록해야 합니다.",
        details: { source: raw },
      }));
      token.attrSet(attribute, "");
    } else if (!safeExternalUrl(raw)) {
      diagnostics.push(problem({
        code: "MARKDOWN_LINK_UNSAFE",
        message: "허용하지 않는 링크 형식 또는 프로토콜입니다.",
        details: { source: raw },
      }));
      token.attrSet(attribute, "");
    }
  });
  return references;
}

export function renderMarkdown(source, options = {}) {
  if (typeof source !== "string") throw new TypeError("Markdown source must be a string");
  const diagnostics = inspectFootnotes(source);
  const md = new MarkdownIt({ html: true, linkify: false, typographer: false }).use(footnote);
  md.validateLink = () => true;
  const env = {};
  const tokens = md.parse(source, env);
  removeRawHtml(tokens, diagnostics);
  const headingData = prepareHeadings(md, tokens, env, diagnostics);
  const references = resolveReferences(tokens, options, diagnostics);
  const rendered = md.renderer.render(tokens, md.options, env);
  const html = sanitizeHtml(rendered, SANITIZE_OPTIONS);
  const footnotes = (env.footnotes?.list ?? []).map((item, index) => ({
    number: index + 1,
    label: item.label ?? null,
    references: item.count ?? 1,
    id: `fn${index + 1}`,
  }));
  const locatedDiagnostics = diagnostics.map((item) => ({
    ...item,
    path: options.path ?? null,
    record_id: options.recordId ?? null,
  }));
  return {
    ok: locatedDiagnostics.every((item) => item.level !== "error"),
    html,
    toc: headingData.toc,
    anchors: headingData.anchors,
    footnotes,
    references,
    diagnostics: locatedDiagnostics,
  };
}

export { SANITIZE_OPTIONS };

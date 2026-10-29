import { open, readdir, stat } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";

import { resolveProjectPath } from "../project/index.js";
import { withBasePath } from "../url/index.js";

const MEDIA_TYPES = Object.freeze({
  "image/png": { extension: ".png", input: [".png"], maxBytes: 20 * 1024 * 1024, kind: "image" },
  "image/jpeg": { extension: ".jpg", input: [".jpg", ".jpeg"], maxBytes: 20 * 1024 * 1024, kind: "image" },
  "image/webp": { extension: ".webp", input: [".webp"], maxBytes: 20 * 1024 * 1024, kind: "image" },
  "image/gif": { extension: ".gif", input: [".gif"], maxBytes: 20 * 1024 * 1024, kind: "image" },
  "application/pdf": { extension: ".pdf", input: [".pdf"], maxBytes: 50 * 1024 * 1024, kind: "document" },
});

function mediaIssue({ level = "error", code, message, assetId = null, details = {} }) {
  return { level, code, message, asset_id: assetId, details };
}

function matchesSignature(type, header) {
  if (type === "image/png") return header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (type === "image/jpeg") return header[0] === 255 && header[1] === 216 && header[2] === 255;
  if (type === "image/gif") return ["GIF87a", "GIF89a"].includes(header.subarray(0, 6).toString("ascii"));
  if (type === "image/webp") return header.subarray(0, 4).toString("ascii") === "RIFF" && header.subarray(8, 12).toString("ascii") === "WEBP";
  if (type === "application/pdf") return header.subarray(0, 5).toString("ascii") === "%PDF-";
  return false;
}

async function inspectAssetFile(root, asset) {
  const specification = MEDIA_TYPES[asset.media_type];
  if (!specification) {
    return { diagnostics: [mediaIssue({
      code: "MEDIA_TYPE_UNSUPPORTED",
      message: "지원하지 않는 미디어 유형입니다.",
      assetId: asset.id,
      details: { media_type: asset.media_type },
    })] };
  }
  const extension = extname(asset.file_path).toLowerCase();
  if (!specification.input.includes(extension)) {
    return { diagnostics: [mediaIssue({
      code: "MEDIA_EXTENSION_MISMATCH",
      message: "미디어 유형과 파일 확장자가 일치하지 않습니다.",
      assetId: asset.id,
      details: { media_type: asset.media_type, extension },
    })] };
  }
  const resolved = await resolveProjectPath(root, asset.file_path);
  const information = await stat(resolved.path);
  const diagnostics = [];
  if (!information.isFile()) {
    diagnostics.push(mediaIssue({
      code: "MEDIA_NOT_REGULAR_FILE",
      message: "미디어 자산은 일반 파일이어야 합니다.",
      assetId: asset.id,
    }));
    return { diagnostics };
  }
  if (information.size > specification.maxBytes) {
    diagnostics.push(mediaIssue({
      code: "MEDIA_FILE_TOO_LARGE",
      message: "미디어 파일이 지원 용량을 초과했습니다.",
      assetId: asset.id,
      details: { size: information.size, limit: specification.maxBytes },
    }));
  }
  const handle = await open(resolved.path, "r");
  const header = Buffer.alloc(16);
  try {
    await handle.read(header, 0, header.length, 0);
  } finally {
    await handle.close();
  }
  if (!matchesSignature(asset.media_type, header)) {
    diagnostics.push(mediaIssue({
      code: "MEDIA_SIGNATURE_MISMATCH",
      message: "미디어 파일 내용이 선언한 유형과 일치하지 않습니다.",
      assetId: asset.id,
      details: { media_type: asset.media_type },
    }));
  }
  return { diagnostics, size: information.size, specification };
}

function assetPublicPath(asset, basePath) {
  const specification = MEDIA_TYPES[asset.media_type];
  return specification
    ? withBasePath(`/assets/media/${asset.id}${specification.extension}`, basePath)
    : null;
}

function assetOutputPath(asset) {
  const specification = MEDIA_TYPES[asset.media_type];
  return specification ? `assets/media/${asset.id}${specification.extension}` : null;
}

export function createAssetResolver(index, { basePath = "/" } = {}) {
  const assets = new Map((index.assets ?? []).map((asset) => [asset.id, asset]));
  return ({ id }) => {
    const asset = assets.get(id);
    if (!asset) {
      return { ok: false, code: "ASSET_REFERENCE_MISSING", message: "참조한 미디어 자산이 없습니다.", details: { asset_id: id } };
    }
    if (asset.status !== "published") {
      return { ok: false, code: "ASSET_REFERENCE_NOT_PUBLIC", message: "참조한 미디어 자산이 공개 상태가 아닙니다.", details: { asset_id: id } };
    }
    const url = assetPublicPath(asset, basePath);
    if (!url) {
      return { ok: false, code: "MEDIA_TYPE_UNSUPPORTED", message: "지원하지 않는 미디어 유형입니다.", details: { asset_id: id, media_type: asset.media_type } };
    }
    return { ok: true, url };
  };
}

async function mediaFiles(root) {
  const start = join(root, "media");
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name !== "assets.json" && entry.name !== ".gitkeep") {
        files.push(relative(root, path).split(sep).join("/"));
      }
    }
  }
  await visit(start);
  return files.sort((left, right) => left.localeCompare(right, "en"));
}

function addUsage(usages, id, usage) {
  const list = usages.get(id) ?? [];
  list.push(usage);
  usages.set(id, list);
}

export async function selectPublicMedia({
  root,
  index,
  publicRecords,
  markdownResults = new Map(),
  commonAssetIds = [],
  basePath = "/",
}) {
  const diagnostics = [];
  const usages = new Map();
  const publicIds = new Set(publicRecords.map((record) => record.id));
  const resultFor = (id) => markdownResults instanceof Map ? markdownResults.get(id) : markdownResults[id];

  for (const id of publicIds) {
    for (const reference of resultFor(id)?.references ?? []) {
      if (reference.kind !== "asset" || reference.invalid) continue;
      addUsage(usages, reference.id, { record_id: id, context: reference.context });
    }
  }
  for (const record of publicRecords) {
    if (record.type === "story" && record.data?.featured_media_id) {
      addUsage(usages, record.data.featured_media_id, { record_id: record.id, context: "featured" });
    }
  }
  for (const id of commonAssetIds) addUsage(usages, id, { record_id: null, context: "common" });

  const assets = new Map((index.assets ?? []).map((asset) => [asset.id, asset]));
  const copyPlan = [];
  for (const [id, assetUsages] of [...usages].sort(([left], [right]) => left.localeCompare(right, "en"))) {
    const asset = assets.get(id);
    if (!asset) {
      diagnostics.push(mediaIssue({ code: "ASSET_REFERENCE_MISSING", message: "공개 콘텐츠가 등록되지 않은 자산을 참조합니다.", assetId: id, details: { usages: assetUsages } }));
      continue;
    }
    if (asset.status !== "published") {
      diagnostics.push(mediaIssue({ code: "ASSET_REFERENCE_NOT_PUBLIC", message: "공개 콘텐츠가 비공개 자산을 참조합니다.", assetId: id, details: { usages: assetUsages } }));
      continue;
    }
    const specification = MEDIA_TYPES[asset.media_type];
    if (assetUsages.some((usage) => ["image", "featured", "common"].includes(usage.context)) && specification?.kind !== "image") {
      diagnostics.push(mediaIssue({ code: "MEDIA_CONTEXT_TYPE_INVALID", message: "이미지 위치에는 래스터 이미지 자산이 필요합니다.", assetId: id, details: { media_type: asset.media_type, usages: assetUsages } }));
      continue;
    }
    let inspection;
    try {
      inspection = await inspectAssetFile(root, asset);
    } catch (error) {
      diagnostics.push(mediaIssue({ code: "MEDIA_FILE_UNREADABLE", message: "미디어 파일을 안전하게 읽을 수 없습니다.", assetId: id, details: { reason: error.code ?? "UNKNOWN" } }));
      continue;
    }
    diagnostics.push(...inspection.diagnostics);
    if (inspection.diagnostics.some((item) => item.level === "error")) continue;
    const outputPath = assetPublicPath(asset, basePath);
    copyPlan.push({
      id,
      source_path: asset.file_path,
      output_path: assetOutputPath(asset),
      url: outputPath,
      media_type: asset.media_type,
      size: inspection.size,
      usages: assetUsages,
    });
  }

  for (const asset of index.assets ?? []) {
    if (!usages.has(asset.id)) {
      diagnostics.push(mediaIssue({ level: "warning", code: "MEDIA_ASSET_UNUSED", message: "현재 공개 결과에서 사용하지 않는 등록 자산입니다.", assetId: asset.id }));
    }
  }
  const registeredPaths = new Set((index.assets ?? []).map((asset) => asset.file_path));
  for (const filePath of await mediaFiles(root)) {
    if (!registeredPaths.has(filePath)) {
      diagnostics.push(mediaIssue({ level: "warning", code: "MEDIA_FILE_UNREGISTERED", message: "assets.json에 등록되지 않은 미디어 파일입니다.", details: { file_path: filePath } }));
    }
  }

  return {
    ok: diagnostics.every((item) => item.level !== "error"),
    used_asset_ids: [...usages.keys()].sort(),
    copy_plan: copyPlan,
    diagnostics,
  };
}

export { MEDIA_TYPES };

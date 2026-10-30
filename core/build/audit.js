import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

function issue(code, message, details = {}) {
  return { level: "error", code, message, details };
}

function portable(path) {
  return path.split(sep).join("/");
}

function textContent(value) {
  return typeof value === "string" ? value : null;
}

function forbiddenSourcePatterns() {
  return [
    { value: "doc:", code: "BUILD_INTERNAL_SCHEME_LEAK" },
    { value: "asset:", code: "BUILD_INTERNAL_SCHEME_LEAK" },
    { value: ".borido/", code: "BUILD_PRIVATE_PATH_LEAK" },
    { value: "media/assets.json", code: "BUILD_PRIVATE_PATH_LEAK" },
    { value: "config/site.json", code: "BUILD_PRIVATE_PATH_LEAK" },
  ];
}

export function privateOutputTokens({ index, publicRecordIds, publicAssetIds, bodiesById }) {
  const publicRecords = new Set(publicRecordIds);
  const publicAssets = new Set(publicAssetIds);
  const publicText = [...publicRecords]
    .map((id) => bodiesById.get(id) ?? "")
    .join("\n");
  const tokens = [];
  for (const record of index.records) {
    if (publicRecords.has(record.id)) continue;
    tokens.push({ value: record.id, kind: "record_id", id: record.id });
    if (record.slug && !publicText.includes(`/${record.slug}/`)) {
      tokens.push({ value: `/${record.slug}/`, kind: "record_path", id: record.id });
    }
    const body = bodiesById.get(record.id) ?? "";
    for (const line of body.split(/\r?\n/u).map((value) => value.trim())) {
      if (line.length >= 16 && !publicText.includes(line)) {
        tokens.push({ value: line, kind: "body", id: record.id });
      }
    }
  }
  for (const asset of index.assets ?? []) {
    if (publicAssets.has(asset.id)) continue;
    tokens.push({ value: asset.id, kind: "asset_id", id: asset.id });
    tokens.push({ value: asset.file_path, kind: "asset_path", id: asset.id });
  }
  return tokens;
}

export function auditStaticOutput({
  files,
  mediaPlan,
  allowedSourceIds,
  privateTokens = [],
}) {
  const diagnostics = [];
  const allowed = new Set(allowedSourceIds);
  const paths = new Set();
  for (const file of files) {
    if (paths.has(file.path)) {
      diagnostics.push(issue("BUILD_OUTPUT_DUPLICATE", "정적 출력 파일 경로가 중복되었습니다.", { path: file.path }));
    }
    paths.add(file.path);
    for (const sourceId of file.source_ids ?? []) {
      if (!allowed.has(sourceId)) {
        diagnostics.push(issue("BUILD_PRIVATE_PROVENANCE", "공개 출력이 허용되지 않은 원본을 출처로 가집니다.", { path: file.path, source_id: sourceId }));
      }
    }
    const content = textContent(file.content);
    if (content === null) continue;
    const searchable = content;
    const patterns = forbiddenSourcePatterns().filter((pattern) => file.path !== "search-index.json" || pattern.code !== "BUILD_INTERNAL_SCHEME_LEAK");
    for (const pattern of patterns) {
      if (searchable.includes(pattern.value)) {
        diagnostics.push(issue(pattern.code, "공개 출력에 내부 참조 또는 비공개 원본 경로가 남았습니다.", { path: file.path, value: pattern.value }));
      }
    }
    for (const token of privateTokens) {
      if (token.value && content.includes(token.value)) {
        diagnostics.push(issue("BUILD_PRIVATE_CONTENT_LEAK", "공개 출력에서 비공개 콘텐츠 표식을 발견했습니다.", { path: file.path, kind: token.kind, source_id: token.id }));
      }
    }
  }
  for (const media of mediaPlan) {
    if (paths.has(media.output_path)) {
      diagnostics.push(issue("BUILD_OUTPUT_DUPLICATE", "페이지와 미디어 출력 경로가 충돌합니다.", { path: media.output_path }));
    }
    paths.add(media.output_path);
  }
  return { ok: diagnostics.length === 0, expected_paths: [...paths].sort(), diagnostics };
}

async function stagedFiles(root) {
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(portable(relative(root, path)));
    }
  }
  await visit(root);
  return files.sort();
}

export async function auditStagedOutput({ root, expectedPaths, privateTokens = [] }) {
  const diagnostics = [];
  const actual = await stagedFiles(root);
  if (JSON.stringify(actual) !== JSON.stringify([...expectedPaths].sort())) {
    diagnostics.push(issue("BUILD_OUTPUT_SET_MISMATCH", "임시 출력의 실제 파일 집합이 검증 계획과 다릅니다.", { expected: [...expectedPaths].sort(), actual }));
  }
  for (const path of actual.filter((value) => /\.(?:html|json|xml|css)$/u.test(value))) {
    const content = await readFile(join(root, path), "utf8");
    const searchable = content;
    const patterns = forbiddenSourcePatterns().filter((pattern) => path !== "search-index.json" || pattern.code !== "BUILD_INTERNAL_SCHEME_LEAK");
    for (const pattern of patterns) {
      if (searchable.includes(pattern.value)) diagnostics.push(issue(pattern.code, "임시 공개 출력에 내부 참조 또는 비공개 원본 경로가 남았습니다.", { path, value: pattern.value }));
    }
    for (const token of privateTokens) {
      if (token.value && content.includes(token.value)) diagnostics.push(issue("BUILD_PRIVATE_CONTENT_LEAK", "임시 공개 출력에서 비공개 콘텐츠 표식을 발견했습니다.", { path, kind: token.kind, source_id: token.id }));
    }
  }
  return { ok: diagnostics.length === 0, diagnostics };
}

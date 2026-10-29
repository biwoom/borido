import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { indexProjectContent } from "../content/indexer.js";
import { selectPublicRecords } from "../content/visibility.js";
import { renderMarkdown } from "../markdown/index.js";
import { createAssetResolver, selectPublicMedia } from "../media/index.js";
import { openProject, ProjectError, resolveProjectPath } from "../project/index.js";
import { generateStaticSite } from "../site/index.js";
import { buildUrlIndex, buildUrlRedirects, createDocumentResolver } from "../url/index.js";
import { auditStagedOutput, auditStaticOutput, privateOutputTokens } from "./audit.js";

const PROGRAM_SITE_ROOT = fileURLToPath(new URL("../../site/", import.meta.url));
const SOURCE_DIRECTORIES = ["content", "config", "media"];

function portable(path) {
  return path.split(sep).join("/");
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function walkFiles(root, directory, prefix = "") {
  const found = [];
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        found.push({ path, name: `${prefix}${portable(relative(root, path))}` });
      }
    }
  }
  await visit(directory);
  return found;
}

export async function snapshotBuildInputs(root) {
  const files = [];
  for (const directory of SOURCE_DIRECTORIES) {
    files.push(...await walkFiles(root, join(root, directory)));
  }
  for (const directory of ["templates", "assets"]) {
    files.push(...await walkFiles(
      PROGRAM_SITE_ROOT,
      join(PROGRAM_SITE_ROOT, directory),
      "@site/",
    ));
  }
  const entries = [];
  for (const file of files.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    const bytes = await readFile(file.path);
    entries.push({ path: file.name, size: bytes.length, sha256: digest(bytes) });
  }
  return { sha256: digest(JSON.stringify(entries)), files: entries };
}

async function loadRecordBodies(root, records) {
  const bodies = new Map();
  for (const record of records) {
    if (!record.data?.body_file) {
      bodies.set(record.id, "");
      continue;
    }
    const resolved = await resolveProjectPath(root, `${record.directory}/${record.data.body_file}`);
    bodies.set(record.id, await readFile(resolved.path, "utf8"));
  }
  return bodies;
}

function compileMarkdown({ records, bodies, urlIndex, index }) {
  const resolveAsset = createAssetResolver(index, { basePath: urlIndex.base_path });
  const anchorsById = new Map();
  for (const record of records) {
    const first = renderMarkdown(bodies.get(record.id) ?? "", {
      recordId: record.id,
      path: record.path,
      resolveAsset,
      resolveDocument: ({ id, anchor }) => ({ ok: true, url: `/__anchor-pass/${id}${anchor ? `#${anchor}` : ""}` }),
    });
    anchorsById.set(record.id, first.anchors);
  }
  const resolveDocument = createDocumentResolver(urlIndex, {
    allRecords: index.records,
    anchorsById,
  });
  const markdownById = new Map();
  const diagnostics = [];
  for (const record of records) {
    const result = renderMarkdown(bodies.get(record.id) ?? "", {
      recordId: record.id,
      path: record.path,
      resolveAsset,
      resolveDocument,
    });
    markdownById.set(record.id, result);
    diagnostics.push(...result.diagnostics);
  }
  return { markdownById, anchorsById, diagnostics };
}

function hasErrors(diagnostics) {
  return diagnostics.some((item) => item.level === "error");
}

function safeOutputPath(root, relativePath) {
  if (typeof relativePath !== "string" || relativePath === "" || relativePath.includes("\\")) {
    throw new ProjectError("BUILD_OUTPUT_PATH_INVALID", "정적 출력 경로가 유효하지 않습니다.", { path: relativePath });
  }
  const target = resolve(root, relativePath);
  const relation = relative(root, target);
  if (relation === "" || relation === ".." || relation.startsWith(`..${sep}`)) {
    throw new ProjectError("BUILD_OUTPUT_PATH_INVALID", "정적 출력 경로가 임시 출력 폴더를 벗어납니다.", { path: relativePath });
  }
  return target;
}

async function writeStage(stageRoot, pageFiles, mediaPlan, projectRoot) {
  for (const file of pageFiles) {
    const target = safeOutputPath(stageRoot, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, typeof file.content === "string" ? "utf8" : undefined);
  }
  for (const media of mediaPlan) {
    const source = await resolveProjectPath(projectRoot, media.source_path);
    const target = safeOutputPath(stageRoot, media.output_path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await readFile(source.path));
  }
}

async function snapshotOutputs(root) {
  const files = await walkFiles(root, root);
  const entries = [];
  for (const file of files) {
    const bytes = await readFile(file.path);
    entries.push({ path: file.name, size: bytes.length, sha256: digest(bytes) });
  }
  entries.sort((left, right) => left.path.localeCompare(right.path, "en"));
  return { sha256: digest(JSON.stringify(entries)), files: entries };
}

async function exists(path) {
  try {
    return await stat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function activateBuild({ projectRoot, stageRoot, operationId, hooks, finalize }) {
  const dist = join(projectRoot, "dist");
  const backup = join(projectRoot, `.borido-dist-backup-${operationId}`);
  const previous = await exists(dist);
  let backedUp = false;
  let activated = false;
  try {
    if (previous) {
      await rename(dist, backup);
      backedUp = true;
    }
    await hooks?.afterBackup?.();
    await rename(stageRoot, dist);
    activated = true;
    await finalize?.();
    if (backedUp) await rm(backup, { recursive: true, force: true });
  } catch (error) {
    await rm(stageRoot, { recursive: true, force: true }).catch(() => {});
    if (activated) await rm(dist, { recursive: true, force: true }).catch(() => {});
    if (backedUp) {
      await rename(backup, dist).catch(() => {});
    }
    throw new ProjectError(
      "BUILD_ACTIVATION_FAILED",
      "새 결과 반영에 실패해 이전 정상 dist를 복원했습니다.",
      {},
      { cause: error },
    );
  }
}

export async function buildProject({ root, hooks = {} }) {
  const opened = await openProject({ root });
  const projectRoot = opened.project.root;
  const input = await snapshotBuildInputs(projectRoot);
  const indexed = await indexProjectContent({ root: projectRoot });
  if (!indexed.ok) return { ok: false, phase: "validation", diagnostics: indexed.diagnostics, summary: indexed.summary };

  const publication = selectPublicRecords(indexed.index.records, {
    overviewTextById: indexed.index.overview_text_by_id,
    blockers: indexed.publication_blockers,
  });
  const site = opened.project.settings;
  const urlIndex = buildUrlIndex({
    index: indexed.index,
    publicRecords: publication.public_records,
    basePath: site.base_path,
    baseUrl: site.base_url,
  });
  const redirectResult = buildUrlRedirects(indexed.index, urlIndex);
  const allBodies = await loadRecordBodies(projectRoot, indexed.index.records);
  const bodies = new Map(publication.public_records.map((record) => [record.id, allBodies.get(record.id) ?? ""]));
  const markdown = compileMarkdown({ records: publication.public_records, bodies, urlIndex, index: indexed.index });
  const media = await selectPublicMedia({
    root: projectRoot,
    index: indexed.index,
    publicRecords: publication.public_records,
    markdownResults: markdown.markdownById,
    commonAssetIds: site.common_asset_ids ?? [],
    basePath: site.base_path,
  });
  const generated = await generateStaticSite({
    site,
    index: indexed.index,
    publicRecords: publication.public_records,
    urlIndex,
    markdownById: markdown.markdownById,
    redirects: redirectResult.redirects,
  });
  const diagnostics = [
    ...indexed.diagnostics,
    ...urlIndex.diagnostics,
    ...redirectResult.diagnostics,
    ...markdown.diagnostics,
    ...media.diagnostics,
    ...generated.diagnostics,
  ];
  const privateTokens = privateOutputTokens({
    index: indexed.index,
    publicRecordIds: publication.public_records.map((record) => record.id),
    publicAssetIds: media.copy_plan.map((asset) => asset.id),
    bodiesById: allBodies,
  });
  const audit = auditStaticOutput({
    files: generated.files,
    mediaPlan: media.copy_plan,
    allowedSourceIds: urlIndex.entries.map((entry) => entry.id),
    privateTokens,
  });
  diagnostics.push(...audit.diagnostics);
  if (hasErrors(diagnostics)) {
    return { ok: false, phase: "generation", diagnostics };
  }

  const operationId = randomUUID();
  const stageRoot = join(projectRoot, `.borido-build-${operationId}`);
  let pendingManifest = null;
  await mkdir(stageRoot);
  try {
    await writeStage(stageRoot, generated.files, media.copy_plan, projectRoot);
    const stagedAudit = await auditStagedOutput({
      root: stageRoot,
      expectedPaths: audit.expected_paths,
      privateTokens,
    });
    if (!stagedAudit.ok) {
      throw new ProjectError(
        "BUILD_OUTPUT_AUDIT_FAILED",
        "임시 공개 결과의 누출 또는 파일 무결성 검사가 실패했습니다.",
        { diagnostics: stagedAudit.diagnostics },
      );
    }
    const output = await snapshotOutputs(stageRoot);
    await hooks?.beforeInputCheck?.();
    const currentInput = await snapshotBuildInputs(projectRoot);
    if (currentInput.sha256 !== input.sha256) {
      throw new ProjectError(
        "BUILD_INPUT_CHANGED",
        "빌드 중 원본 또는 템플릿이 변경되어 결과를 반영하지 않았습니다.",
        { before: input.sha256, after: currentInput.sha256 },
      );
    }
    const manifestDirectory = join(projectRoot, ".borido", "builds");
    await mkdir(manifestDirectory, { recursive: true });
    const manifest = {
      schema_version: 1,
      operation_id: operationId,
      input,
      output,
      public_record_ids: publication.public_records.map((record) => record.id).sort(),
      public_asset_ids: media.copy_plan.map((asset) => asset.id).sort(),
    };
    pendingManifest = join(manifestDirectory, `${operationId}.json`);
    const latestManifest = join(manifestDirectory, "latest.json");
    await writeFile(pendingManifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await activateBuild({
      projectRoot,
      stageRoot,
      operationId,
      hooks,
      finalize: () => rename(pendingManifest, latestManifest),
    });
    return {
      ok: true,
      phase: "complete",
      root: projectRoot,
      dist: join(projectRoot, "dist"),
      summary: {
        pages: generated.pages.length,
        files: output.files.length,
        assets: media.copy_plan.length,
        warnings: diagnostics.filter((item) => item.level === "warning").length,
      },
      diagnostics: diagnostics.filter((item) => item.level === "warning"),
      manifest: { input_sha256: input.sha256, output_sha256: output.sha256 },
    };
  } catch (error) {
    await rm(stageRoot, { recursive: true, force: true }).catch(() => {});
    if (pendingManifest) await rm(pendingManifest, { force: true }).catch(() => {});
    throw error;
  }
}

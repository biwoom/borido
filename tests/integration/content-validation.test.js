import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

import { afterEach, describe, expect, it } from "vitest";

import { indexProjectContent } from "../../core/content/index.js";
import {
  initializeProject,
  newProjectSettings,
} from "../../core/project/index.js";

const programRoot = fileURLToPath(new URL("../../", import.meta.url));
const fixtureRoot = join(programRoot, "tests", "fixtures", "w05-valid-project");

async function listFiles(root) {
  const result = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) result.push(path);
    }
  }
  await visit(root);
  return result;
}

async function projectDigest(root) {
  const hash = createHash("sha256");
  for (const path of await listFiles(root)) {
    hash.update(relative(root, path));
    hash.update(await readFile(path));
  }
  return hash.digest("hex");
}

async function runCli(...args) {
  const child = spawn(process.execPath, ["scripts/validate.mjs", ...args], {
    cwd: programRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const [code] = await once(child, "exit");
  return {
    code,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

describe("W05 project content validation", () => {
  const sandboxes = [];

  afterEach(async () => {
    await Promise.all(
      sandboxes.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  async function fixtureCopy(name = "project") {
    const sandbox = await mkdtemp(join(tmpdir(), "borido-w05-"));
    sandboxes.push(sandbox);
    const root = join(sandbox, name);
    await cp(fixtureRoot, root, { recursive: true });
    return root;
  }

  it("indexes the complete synthetic fixture without modifying source files", async () => {
    const root = await fixtureCopy();
    const before = await projectDigest(root);
    const report = await indexProjectContent({ root });
    const after = await projectDigest(root);

    expect(report.ok).toBe(true);
    expect(report.summary).toEqual({
      records: 8,
      assets: 1,
      taxonomies: 1,
      url_history_entries: 0,
      errors: 0,
      warnings: 0,
    });
    const document = report.index.records.find(
      (record) => record.type === "text_document",
    );
    expect(document).toMatchObject({
      parent_id: "10000000-0000-4000-8000-000000000002",
      text_id: "10000000-0000-4000-8000-000000000001",
      area: "translation",
    });
    expect(after).toBe(before);
  });

  it("accepts a new empty W04 project without creating optional files", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "borido-w05-empty-"));
    sandboxes.push(sandbox);
    const root = join(sandbox, "empty-project");
    await initializeProject({
      root,
      settings: newProjectSettings({
        siteName: "빈 프로젝트",
        defaultLanguage: "ko",
        timezone: "Asia/Seoul",
      }),
    });
    const before = await projectDigest(root);
    const report = await indexProjectContent({ root });
    expect(report.ok).toBe(true);
    expect(report.summary.records).toBe(0);
    expect(report.summary.assets).toBe(0);
    expect(await projectDigest(root)).toBe(before);
  });

  it("reports schema, duplicate, body, area, and timestamp problems without repair", async () => {
    const root = await fixtureCopy("invalid-project");
    const storyPath = join(root, "content", "stories", "synthetic-story", "meta.json");
    const story = JSON.parse(await readFile(storyPath, "utf8"));
    story.id = "10000000-0000-4000-8000-000000000001";
    story.updated_at = "2026-10-28T00:00:00Z";
    story.invented = true;
    await writeFile(storyPath, `${JSON.stringify(story, null, 2)}\n`, "utf8");
    await unlink(join(dirname(storyPath), "story.md"));

    const areaPath = join(
      root,
      "content",
      "texts",
      "synthetic-text",
      "research",
      "_node.json",
    );
    const area = JSON.parse(await readFile(areaPath, "utf8"));
    area.area = "original";
    await writeFile(areaPath, `${JSON.stringify(area, null, 2)}\n`, "utf8");

    const before = await projectDigest(root);
    const report = await indexProjectContent({ root });
    const codes = report.diagnostics.map((item) => item.code);
    expect(report.ok).toBe(false);
    expect(codes).toEqual(
      expect.arrayContaining([
        "UNSUPPORTED_FIELD",
        "DUPLICATE_RECORD_ID",
        "DUPLICATE_PROJECT_UUID",
        "UPDATED_BEFORE_CREATED",
        "BODY_FILE_MISSING",
        "TEXT_AREA_CODE_MISMATCH",
      ]),
    );
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        path: "content/stories/synthetic-story/meta.json",
        record_id: "10000000-0000-4000-8000-000000000001",
      }),
    );
    expect(await projectDigest(root)).toBe(before);
  });

  it("does not follow project symlinks", async () => {
    const root = await fixtureCopy();
    const outside = join(dirname(root), "outside.json");
    await writeFile(outside, '{"secret":true}\n', "utf8");
    await symlink(outside, join(root, "content", "pages", "outside.json"));
    const report = await indexProjectContent({ root });
    expect(report.ok).toBe(false);
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "PROJECT_PATH_SYMLINK_NOT_ALLOWED",
        path: "content/pages/outside.json",
      }),
    );
  });

  it("keeps warnings non-blocking and reports deferred editing policy explicitly", async () => {
    const root = await fixtureCopy();
    const originalPath = join(
      root,
      "content",
      "texts",
      "synthetic-text",
      "original",
      "_node.json",
    );
    const original = JSON.parse(await readFile(originalPath, "utf8"));
    original.order = 10;
    await writeFile(originalPath, `${JSON.stringify(original, null, 2)}\n`, "utf8");
    await writeFile(
      join(root, "config", "content-types.json"),
      '{"schema_version":1}\n',
      "utf8",
    );
    const report = await indexProjectContent({ root });
    expect(report.ok).toBe(true);
    expect(report.summary).toMatchObject({ errors: 0, warnings: 3 });
    expect(report.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "ORDER_TIE",
        "CONTENT_TYPES_POLICY_DEFERRED",
      ]),
    );
  });

  it("reports taxonomy code mismatches and media path escapes", async () => {
    const root = await fixtureCopy();
    const canonPath = join(root, "config", "canons", "taisho.json");
    const canon = JSON.parse(await readFile(canonPath, "utf8"));
    canon.canon_id = "different-canon";
    await writeFile(canonPath, `${JSON.stringify(canon, null, 2)}\n`, "utf8");

    const assetsPath = join(root, "media", "assets.json");
    const assets = JSON.parse(await readFile(assetsPath, "utf8"));
    assets.assets[0].file_path = "media/images/../../outside.png";
    await writeFile(assetsPath, `${JSON.stringify(assets, null, 2)}\n`, "utf8");
    const report = await indexProjectContent({ root });
    expect(report.ok).toBe(false);
    expect(report.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "CANON_FILE_CODE_MISMATCH",
        "CANON_SECTION_CODE_MISMATCH",
        "ASSET_PATH_OUTSIDE_MEDIA",
      ]),
    );
  });

  it("runs the documented CLI with stable exit codes and JSON", async () => {
    const root = await fixtureCopy();
    const valid = await runCli(root);
    expect(valid.code).toBe(0);
    expect(valid.stderr).toBe("");
    expect(JSON.parse(valid.stdout)).toMatchObject({
      ok: true,
      summary: { records: 8, errors: 0 },
    });

    const metaPath = join(root, "content", "pages", "about", "meta.json");
    const page = JSON.parse(await readFile(metaPath, "utf8"));
    page.schema_version = 99;
    await writeFile(metaPath, `${JSON.stringify(page, null, 2)}\n`, "utf8");
    const invalid = await runCli(root);
    expect(invalid.code).toBe(1);
    expect(JSON.parse(invalid.stdout).diagnostics).toContainEqual(
      expect.objectContaining({ code: "UNSUPPORTED_SCHEMA_VERSION" }),
    );
  });

  it("returns the documented usage exit code without a project argument", async () => {
    const result = await runCli();
    expect(result.code).toBe(2);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: "INVALID_VALIDATE_COMMAND" },
    });
  });
});

import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  defaultProjectRoot,
  errorResponse,
  initializeProject,
  newProjectSettings,
  openProject,
  PROJECT_DIRECTORIES,
  writeProjectSettings,
} from "../../core/project/index.js";

const programRoot = fileURLToPath(new URL("../../", import.meta.url));
const execFileAsync = promisify(execFile);
const sandboxes = [];

async function sandbox() {
  const path = await mkdtemp(join(tmpdir(), "borido-w02-"));
  sandboxes.push(path);
  return path;
}

function settings(siteName = "격리 프로젝트") {
  return newProjectSettings({
    siteName,
    defaultLanguage: "ko",
    timezone: "Asia/Seoul",
  });
}

afterEach(async () => {
  await Promise.all(
    sandboxes.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("W02 project lifecycle", () => {
  it("initializes a new external project and reopens the same settings", async () => {
    const parent = await sandbox();
    const root = join(parent, "project-a");
    const initialized = await initializeProject({
      root,
      settings: settings(),
      programRoot,
    });

    expect(initialized.project.root).toBe(await realpath(root));
    expect(initialized.project.settings.site_name).toBe("격리 프로젝트");
    expect(initialized.project.settings.deployment).toBeNull();
    expect(initialized.project.settings.source_repository).toBeNull();
    expect(initialized.project.settings_revision).toMatch(/^[a-f0-9]{64}$/);

    for (const directory of PROJECT_DIRECTORIES) {
      expect((await stat(join(root, directory))).isDirectory()).toBe(true);
    }

    await rm(join(root, "dist"), { recursive: true });
    const reopened = await openProject({ root, programRoot });
    expect(reopened).toEqual(initialized);
  });

  it("keeps two explicitly selected project roots independent", async () => {
    const parent = await sandbox();
    const first = await initializeProject({
      root: join(parent, "first"),
      settings: settings("첫 프로젝트"),
      programRoot,
    });
    const second = await initializeProject({
      root: join(parent, "second"),
      settings: settings("둘째 프로젝트"),
      programRoot,
    });

    expect(first.project.root).not.toBe(second.project.root);
    expect(first.project.settings.site_name).toBe("첫 프로젝트");
    expect(second.project.settings.site_name).toBe("둘째 프로젝트");
  });

  it("does not overwrite an existing path or create a project in the program checkout", async () => {
    const parent = await sandbox();
    const existing = join(parent, "existing");
    await writeFile(existing, "사용자 파일", "utf8");

    await expect(
      initializeProject({ root: existing, settings: settings(), programRoot }),
    ).rejects.toMatchObject({ code: "PROJECT_NOT_DIRECTORY" });
    expect(await readFile(existing, "utf8")).toBe("사용자 파일");

    const existingDirectory = join(parent, "existing-directory");
    await mkdir(existingDirectory);
    await writeFile(join(existingDirectory, "keep.txt"), "보존", "utf8");
    await expect(
      initializeProject({
        root: existingDirectory,
        settings: settings(),
        programRoot,
      }),
    ).rejects.toMatchObject({ code: "PROJECT_TARGET_EXISTS" });
    expect(await readFile(join(existingDirectory, "keep.txt"), "utf8")).toBe(
      "보존",
    );

    const insideProgram = join(programRoot, "w02-must-not-exist");
    await expect(
      initializeProject({
        root: insideProgram,
        settings: settings(),
        programRoot,
      }),
    ).rejects.toMatchObject({ code: "PROJECT_INSIDE_PROGRAM_ROOT" });
  });

  it("allows only the reserved project directory inside a program checkout", async () => {
    const fakeProgramRoot = join(await sandbox(), "program");
    await mkdir(fakeProgramRoot);
    const integratedRoot = defaultProjectRoot(fakeProgramRoot);
    const initialized = await initializeProject({
      root: integratedRoot,
      settings: settings("통합 프로젝트"),
      programRoot: fakeProgramRoot,
    });
    expect(initialized.project.root).toBe(await realpath(integratedRoot));

    await expect(
      initializeProject({
        root: join(fakeProgramRoot, "other"),
        settings: settings(),
        programRoot: fakeProgramRoot,
      }),
    ).rejects.toMatchObject({ code: "PROJECT_INSIDE_PROGRAM_ROOT" });
  });

  it("requires a current content revision before replacing settings", async () => {
    const parent = await sandbox();
    const root = join(parent, "revision-project");
    const initialized = await initializeProject({
      root,
      settings: settings(),
      programRoot,
    });
    const updatedSettings = {
      ...initialized.project.settings,
      site_name: "변경된 이름",
    };
    const updated = await writeProjectSettings({
      root,
      settings: updatedSettings,
      expectedRevision: initialized.project.settings_revision,
      programRoot,
    });
    expect(updated.project.settings.site_name).toBe("변경된 이름");

    const configPath = join(root, "config", "site.json");
    const externallyChanged = `${await readFile(configPath, "utf8")}\n`;
    await writeFile(configPath, externallyChanged, "utf8");

    await expect(
      writeProjectSettings({
        root,
        settings: { ...updated.project.settings, site_name: "덮어쓰기" },
        expectedRevision: updated.project.settings_revision,
        programRoot,
      }),
    ).rejects.toMatchObject({ code: "PROJECT_REVISION_CONFLICT" });
    expect(await readFile(configPath, "utf8")).toBe(externallyChanged);
  });

  it("returns stable JSON errors for invalid existing projects", async () => {
    const parent = await sandbox();
    const missing = join(parent, "missing");
    let response;
    try {
      await openProject({ root: missing, programRoot });
    } catch (error) {
      response = errorResponse(error);
    }

    expect(response).toEqual({
      ok: false,
      error: {
        code: "PROJECT_NOT_FOUND",
        message: "선택한 프로젝트 폴더가 존재하지 않습니다.",
        details: {},
      },
    });
  });

  it("connects the project CLI to the same offline contract", async () => {
    const parent = await sandbox();
    const root = join(parent, "cli-project");
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [
        "scripts/project.mjs",
        "init",
        root,
        "--name",
        "CLI 프로젝트",
        "--language",
        "ko",
        "--timezone",
        "Asia/Seoul",
      ],
      { cwd: programRoot },
    );

    expect(stderr).toBe("");
    const result = JSON.parse(stdout);
    expect(result.project.settings.site_name).toBe("CLI 프로젝트");
    expect(result.project.settings.base_url).toBeNull();
    expect(result.project.settings.deployment).toBeNull();
  });

  it.runIf(process.platform !== "win32")(
    "reports a permission error without creating a partial project",
    async () => {
      const parent = await sandbox();
      const locked = join(parent, "locked");
      const target = join(locked, "project");
      await mkdir(locked);
      await chmod(locked, 0o500);
      try {
        await expect(
          initializeProject({ root: target, settings: settings(), programRoot }),
        ).rejects.toMatchObject({ code: "PROJECT_PERMISSION_DENIED" });
      } finally {
        await chmod(locked, 0o700);
      }
      await expect(openProject({ root: target, programRoot })).rejects.toMatchObject({
        code: "PROJECT_NOT_FOUND",
      });
    },
  );
});

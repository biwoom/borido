import { randomUUID } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { asProjectError, ProjectError } from "./errors.js";
import {
  createSiteSettings,
  settingsRevision,
  validateSiteSettings,
} from "./settings.js";

const REQUIRED_PROJECT_DIRECTORIES = Object.freeze([
  "content/texts",
  "content/stories",
  "content/blog",
  "content/pages",
  "media/images",
  "media/documents",
  "media/icons",
  "config/canons",
]);

export const PROJECT_DIRECTORIES = Object.freeze([
  ...REQUIRED_PROJECT_DIRECTORIES,
  "dist",
]);

const DEFAULT_PROGRAM_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function isMissing(error) {
  return error?.code === "ENOENT";
}

async function exists(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function canonicalExistingPath(path) {
  try {
    return await realpath(path);
  } catch (error) {
    throw asProjectError(error);
  }
}

async function resolveNewRoot(root) {
  if (typeof root !== "string" || root.trim() === "") {
    throw new ProjectError(
      "INVALID_PROJECT_ROOT",
      "프로젝트 루트를 명시해야 합니다.",
    );
  }
  const absolute = resolve(root);
  const parent = dirname(absolute);
  const parentInfo = await exists(parent);
  if (!parentInfo) {
    throw new ProjectError(
      "PROJECT_PARENT_NOT_FOUND",
      "프로젝트를 만들 상위 폴더가 존재하지 않습니다.",
    );
  }
  if (!parentInfo.isDirectory()) {
    throw new ProjectError(
      "PROJECT_PARENT_NOT_DIRECTORY",
      "프로젝트 상위 경로가 폴더가 아닙니다.",
    );
  }
  return join(await canonicalExistingPath(parent), basename(absolute));
}

async function assertOutsideProgramRoot(projectRoot, programRoot) {
  const canonicalProgram = await canonicalExistingPath(programRoot);
  const relation = relative(canonicalProgram, projectRoot);
  if (relation === "" || (!relation.startsWith("..") && !isAbsolute(relation))) {
    throw new ProjectError(
      "PROJECT_INSIDE_PROGRAM_ROOT",
      "사용자 프로젝트는 프로그램 체크아웃 밖에 두어야 합니다.",
    );
  }
}

async function readSettingsFile(projectRoot) {
  const path = join(projectRoot, "config", "site.json");
  let content;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) {
      throw new ProjectError(
        "PROJECT_NOT_INITIALIZED",
        "config/site.json이 없어 보리도 프로젝트로 열 수 없습니다.",
      );
    }
    throw asProjectError(error);
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new ProjectError(
      "INVALID_SITE_JSON",
      "config/site.json이 유효한 JSON이 아닙니다.",
    );
  }
  return { content, ...validateSiteSettings(parsed) };
}

function projectResult(root, settingsFile) {
  return {
    ok: true,
    project: {
      root,
      settings: settingsFile.settings,
      settings_revision: settingsRevision(settingsFile.content),
      editable: settingsFile.editable,
      diagnostics: settingsFile.diagnostics,
    },
  };
}

export async function initializeProject({
  root,
  settings,
  programRoot = DEFAULT_PROGRAM_ROOT,
}) {
  const projectRoot = await resolveNewRoot(root);
  await assertOutsideProgramRoot(projectRoot, programRoot);

  const existing = await exists(projectRoot);
  if (existing) {
    if (!existing.isDirectory()) {
      throw new ProjectError(
        "PROJECT_NOT_DIRECTORY",
        "선택한 프로젝트 경로가 폴더가 아닙니다.",
      );
    }
    if (await exists(join(projectRoot, ".borido-initializing"))) {
      throw new ProjectError(
        "PROJECT_INITIALIZATION_INCOMPLETE",
        "중단된 프로젝트 초기화 흔적이 있습니다. 경로를 점검해야 합니다.",
      );
    }
    throw new ProjectError(
      "PROJECT_TARGET_EXISTS",
      "신규 프로젝트 경로가 이미 존재합니다. 기존 프로젝트 열기와 구분해야 합니다.",
    );
  }

  const normalizedSettings = validateSiteSettings(
    settings ?? createSiteSettings({}),
    { allowUnknown: false },
  ).settings;
  const parent = dirname(projectRoot);
  try {
    await access(parent, constants.R_OK | constants.W_OK);
  } catch (error) {
    throw asProjectError(error);
  }

  const stagingRoot = join(parent, `.borido-init-${randomUUID()}`);
  const initializationId = randomUUID();
  let targetReserved = false;
  try {
    await mkdir(stagingRoot);
    for (const directory of PROJECT_DIRECTORIES) {
      await mkdir(join(stagingRoot, directory), { recursive: true });
    }
    await writeFile(
      join(stagingRoot, "config", "site.json"),
      `${JSON.stringify(normalizedSettings, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    await mkdir(projectRoot);
    targetReserved = true;
    await writeFile(join(projectRoot, ".borido-initializing"), initializationId, {
      encoding: "utf8",
      flag: "wx",
    });
    for (const topLevel of ["content", "media", "config", "dist"]) {
      await rename(join(stagingRoot, topLevel), join(projectRoot, topLevel));
    }
    await rm(join(projectRoot, ".borido-initializing"));
    await rm(stagingRoot, { recursive: true });
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
    if (targetReserved) {
      throw new ProjectError(
        "PROJECT_INITIALIZATION_INCOMPLETE",
        "프로젝트 초기화가 중단되었습니다. 기존 파일을 덮어쓰지 않았으며 경로를 점검해야 합니다.",
        {},
        { cause: error },
      );
    }
    if (error?.code === "EEXIST" || error?.code === "ENOTEMPTY") {
      throw new ProjectError(
        "PROJECT_TARGET_EXISTS",
        "초기화 중 대상 경로가 생성되어 반영하지 않았습니다.",
      );
    }
    throw asProjectError(error);
  }

  return openProject({ root: projectRoot, programRoot });
}

export async function openProject({ root, programRoot = DEFAULT_PROGRAM_ROOT }) {
  if (typeof root !== "string" || root.trim() === "") {
    throw new ProjectError(
      "INVALID_PROJECT_ROOT",
      "프로젝트 루트를 명시해야 합니다.",
    );
  }
  let projectRoot;
  try {
    projectRoot = await realpath(resolve(root));
  } catch (error) {
    if (isMissing(error)) {
      throw new ProjectError(
        "PROJECT_NOT_FOUND",
        "선택한 프로젝트 폴더가 존재하지 않습니다.",
      );
    }
    throw asProjectError(error);
  }
  await assertOutsideProgramRoot(projectRoot, programRoot);
  const info = await exists(projectRoot);
  if (!info?.isDirectory()) {
    throw new ProjectError(
      "PROJECT_NOT_DIRECTORY",
      "선택한 프로젝트 경로가 폴더가 아닙니다.",
    );
  }
  if (await exists(join(projectRoot, ".borido-initializing"))) {
    throw new ProjectError(
      "PROJECT_INITIALIZATION_INCOMPLETE",
      "중단된 프로젝트 초기화 흔적이 있습니다. 경로를 점검해야 합니다.",
    );
  }
  try {
    await access(projectRoot, constants.R_OK);
    for (const directory of REQUIRED_PROJECT_DIRECTORIES) {
      const directoryInfo = await exists(join(projectRoot, directory));
      if (!directoryInfo?.isDirectory()) {
        throw new ProjectError(
          "PROJECT_STRUCTURE_INCOMPLETE",
          "필수 프로젝트 폴더가 없거나 올바르지 않습니다.",
          { path: directory },
        );
      }
    }
  } catch (error) {
    throw asProjectError(error);
  }
  const settingsFile = await readSettingsFile(projectRoot);
  return projectResult(projectRoot, settingsFile);
}

export async function writeProjectSettings({
  root,
  settings,
  expectedRevision,
  programRoot = DEFAULT_PROGRAM_ROOT,
}) {
  const opened = await openProject({ root, programRoot });
  if (!opened.project.editable) {
    throw new ProjectError(
      "SITE_SETTINGS_NOT_EDITABLE",
      "지원하지 않는 필드가 있어 설정을 보존하고 저장을 차단했습니다.",
      { diagnostics: opened.project.diagnostics },
    );
  }
  if (
    typeof expectedRevision !== "string" ||
    expectedRevision !== opened.project.settings_revision
  ) {
    throw new ProjectError(
      "PROJECT_REVISION_CONFLICT",
      "설정 파일이 외부에서 변경되어 덮어쓰지 않았습니다.",
    );
  }

  const normalized = validateSiteSettings(settings, { allowUnknown: false }).settings;
  const configPath = join(opened.project.root, "config", "site.json");
  const temporaryPath = join(
    opened.project.root,
    "config",
    `.site-${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporaryPath, configPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw asProjectError(error);
  }
  return openProject({ root: opened.project.root, programRoot });
}

export function newProjectSettings(input) {
  return createSiteSettings(input);
}

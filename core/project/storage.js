import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { asProjectError, ProjectError } from "./errors.js";
import { resolveProjectPath } from "./path.js";
import { openProject } from "./project.js";

const MANAGED_PREFIXES = Object.freeze(["content/", "media/", "config/"]);
const projectQueues = new Map();

export function fileRevision(content) {
  return createHash("sha256").update(content).digest("hex");
}

function assertManagedPath(path) {
  if (
    typeof path !== "string" ||
    !MANAGED_PREFIXES.some((prefix) => path.startsWith(prefix))
  ) {
    throw new ProjectError(
      "PROJECT_FILE_NOT_MANAGED",
      "content/, media/, config/ 안의 원본 파일만 저장 작업으로 변경할 수 있습니다.",
      { path },
    );
  }
}

async function fileState(projectRoot, path) {
  const resolved = await resolveProjectPath(projectRoot, path, { mustExist: false });
  let info;
  try {
    info = await lstat(resolved.path);
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, ...resolved };
    throw asProjectError(error);
  }
  if (!info.isFile()) {
    throw new ProjectError(
      "PROJECT_PATH_NOT_FILE",
      "저장 대상은 일반 파일이어야 합니다.",
      { path },
    );
  }
  const content = await readFile(resolved.path);
  return {
    exists: true,
    content,
    revision: fileRevision(content),
    ...resolved,
  };
}

export async function readProjectTextFile({ root, path, programRoot }) {
  const opened = await openProject({ root, programRoot });
  assertManagedPath(path);
  const state = await fileState(opened.project.root, path);
  if (!state.exists) {
    throw new ProjectError(
      "PROJECT_PATH_NOT_FOUND",
      "프로젝트 상대 경로가 존재하지 않습니다.",
      { path },
    );
  }
  return {
    path,
    content: state.content.toString("utf8"),
    revision: state.revision,
  };
}

async function atomicWrite(path, content) {
  const temporaryPath = join(dirname(path), `.borido-write-${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, content, { flag: "wx" });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

function normalizeChanges(changes) {
  if (!Array.isArray(changes) || changes.length === 0) {
    throw new ProjectError(
      "PROJECT_CHANGES_REQUIRED",
      "하나 이상의 파일 변경이 필요합니다.",
    );
  }
  const seen = new Set();
  return changes.map((change) => {
    if (!change || typeof change !== "object" || Array.isArray(change)) {
      throw new ProjectError("PROJECT_CHANGE_INVALID", "파일 변경 객체가 필요합니다.");
    }
    const { path, action = "write", expectedRevision } = change;
    assertManagedPath(path);
    if (seen.has(path)) {
      throw new ProjectError(
        "PROJECT_CHANGE_DUPLICATE_PATH",
        "한 작업에서 같은 파일을 두 번 변경할 수 없습니다.",
        { path },
      );
    }
    seen.add(path);
    if (!["write", "delete"].includes(action)) {
      throw new ProjectError("PROJECT_CHANGE_INVALID", "지원하지 않는 파일 변경입니다.", {
        path,
        action,
      });
    }
    if (action === "write" && typeof change.content !== "string") {
      throw new ProjectError(
        "PROJECT_CHANGE_INVALID",
        "텍스트 저장에는 문자열 content가 필요합니다.",
        { path },
      );
    }
    if (expectedRevision !== null && typeof expectedRevision !== "string") {
      throw new ProjectError(
        "PROJECT_REVISION_REQUIRED",
        "기존 파일은 SHA-256 리비전, 새 파일은 null 리비전이 필요합니다.",
        { path },
      );
    }
    return { path, action, content: change.content, expectedRevision };
  });
}

function assertRevision(change, state) {
  const actual = state.exists ? state.revision : null;
  if (change.expectedRevision !== actual) {
    throw new ProjectError(
      "PROJECT_FILE_REVISION_CONFLICT",
      "프로젝트 파일이 외부에서 변경되어 작업을 중단했습니다.",
      { path: change.path, expected: change.expectedRevision, actual },
    );
  }
  if (change.action === "delete" && !state.exists) {
    throw new ProjectError(
      "PROJECT_PATH_NOT_FOUND",
      "삭제할 프로젝트 파일이 없습니다.",
      { path: change.path },
    );
  }
}

async function writeManifest(operationRoot, manifest) {
  await writeFile(
    join(operationRoot, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

async function withProjectQueue(root, action) {
  const previous = projectQueues.get(root) ?? Promise.resolve();
  let release;
  const current = new Promise((resolveQueue) => {
    release = resolveQueue;
  });
  const tail = previous.then(() => current);
  projectQueues.set(root, tail);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (projectQueues.get(root) === tail) projectQueues.delete(root);
  }
}

export async function applyProjectFileChanges({
  root,
  changes,
  programRoot,
  operationId = randomUUID(),
  _beforeApply = null,
}) {
  const opened = await openProject({ root, programRoot });
  const projectRoot = opened.project.root;
  const normalized = normalizeChanges(changes);

  return withProjectQueue(projectRoot, async () => {
    const prepared = [];
    for (const change of normalized) {
      const state = await fileState(projectRoot, change.path);
      assertRevision(change, state);
      prepared.push({ change, state });
    }

    const operationRoot = join(projectRoot, ".borido", "recovery", operationId);
    const backupRoot = join(operationRoot, "files");
    await mkdir(backupRoot, { recursive: true });
    const manifest = {
      schema_version: 1,
      operation_id: operationId,
      status: "prepared",
      changes: prepared.map(({ change, state }) => ({
        path: change.path,
        action: change.action,
        before_revision: state.exists ? state.revision : null,
      })),
    };
    for (const { change, state } of prepared) {
      if (!state.exists) continue;
      const backup = join(backupRoot, change.path);
      await mkdir(dirname(backup), { recursive: true });
      await writeFile(backup, state.content, { flag: "wx" });
    }
    await writeManifest(operationRoot, manifest);

    const applied = [];
    try {
      manifest.status = "applying";
      await writeManifest(operationRoot, manifest);
      for (let index = 0; index < prepared.length; index += 1) {
        const item = prepared[index];
        const current = await fileState(projectRoot, item.change.path);
        assertRevision(item.change, current);
        if (_beforeApply) await _beforeApply({ index, change: item.change });
        if (item.change.action === "write") {
          await atomicWrite(current.path, Buffer.from(item.change.content, "utf8"));
        } else {
          await rm(current.path);
        }
        applied.push(item);
      }
      manifest.status = "completed";
      await writeManifest(operationRoot, manifest);
      const results = [];
      for (const { change } of prepared) {
        const state = await fileState(projectRoot, change.path);
        const result = {
          path: change.path,
          action: change.action,
          revision: state.exists ? state.revision : null,
        };
        results.push(result);
        const manifestChange = manifest.changes.find(
          (entry) => entry.path === change.path,
        );
        manifestChange.after_revision = result.revision;
      }
      await writeManifest(operationRoot, manifest);
      return { ok: true, operation_id: operationId, changes: results };
    } catch (error) {
      let rollbackError = null;
      for (const item of applied.reverse()) {
        try {
          if (item.state.exists) {
            const backup = await readFile(join(backupRoot, item.change.path));
            await atomicWrite(item.state.path, backup);
          } else {
            await rm(item.state.path, { force: true });
          }
        } catch (caught) {
          rollbackError ??= caught;
        }
      }
      manifest.status = rollbackError ? "recovery_required" : "rolled_back";
      manifest.error_code = error.code ?? "PROJECT_IO_ERROR";
      await writeManifest(operationRoot, manifest).catch(() => {});
      if (rollbackError) {
        throw new ProjectError(
          "PROJECT_RECOVERY_REQUIRED",
          "파일 작업과 자동 복원이 모두 실패해 복구가 필요합니다.",
          { operation_id: operationId },
          { cause: rollbackError },
        );
      }
      throw asProjectError(error);
    }
  });
}

function assertOperationId(operationId) {
  if (
    typeof operationId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      operationId,
    )
  ) {
    throw new ProjectError(
      "PROJECT_OPERATION_ID_INVALID",
      "복구 작업 ID가 유효하지 않습니다.",
    );
  }
}

async function readOperationManifest(projectRoot, operationId) {
  assertOperationId(operationId);
  const operationRoot = join(projectRoot, ".borido", "recovery", operationId);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(operationRoot, "manifest.json"), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) {
      throw new ProjectError(
        "PROJECT_RECOVERY_NOT_FOUND",
        "복구 작업 기록을 찾거나 읽을 수 없습니다.",
        { operation_id: operationId },
      );
    }
    throw asProjectError(error);
  }
  return { operationRoot, manifest };
}

export async function listProjectRecoveryOperations({ root, programRoot }) {
  const opened = await openProject({ root, programRoot });
  const recoveryRoot = join(opened.project.root, ".borido", "recovery");
  let entries;
  try {
    entries = await readdir(recoveryRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw asProjectError(error);
  }
  const operations = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    try {
      operations.push((await readOperationManifest(opened.project.root, entry.name)).manifest);
    } catch (error) {
      operations.push({
        operation_id: entry.name,
        status: "unreadable",
        error_code: error.code ?? "PROJECT_IO_ERROR",
      });
    }
  }
  return operations;
}

export async function recoverProjectFileOperation({
  root,
  operationId,
  programRoot,
}) {
  const opened = await openProject({ root, programRoot });
  const projectRoot = opened.project.root;
  return withProjectQueue(projectRoot, async () => {
    const { operationRoot, manifest } = await readOperationManifest(
      projectRoot,
      operationId,
    );
    if (!["completed", "applying", "recovery_required"].includes(manifest.status)) {
      throw new ProjectError(
        "PROJECT_RECOVERY_NOT_AVAILABLE",
        "이 작업은 복구할 상태가 아닙니다.",
        { operation_id: operationId, status: manifest.status ?? null },
      );
    }
    if (!Array.isArray(manifest.changes)) {
      throw new ProjectError(
        "PROJECT_RECOVERY_NOT_FOUND",
        "복구 작업 기록의 변경 목록이 없습니다.",
        { operation_id: operationId },
      );
    }

    if (manifest.status === "completed") {
      for (const change of manifest.changes) {
        const current = await fileState(projectRoot, change.path);
        const actual = current.exists ? current.revision : null;
        if (actual !== change.after_revision) {
          throw new ProjectError(
            "PROJECT_RECOVERY_REVISION_CONFLICT",
            "작업 완료 뒤 파일이 변경되어 복구로 덮어쓰지 않았습니다.",
            { path: change.path, expected: change.after_revision, actual },
          );
        }
      }
    }

    try {
      for (const change of [...manifest.changes].reverse()) {
        const target = await resolveProjectPath(projectRoot, change.path, {
          mustExist: false,
        });
        if (change.before_revision === null) {
          await rm(target.path, { force: true });
        } else {
          const backup = await readFile(join(operationRoot, "files", change.path));
          if (fileRevision(backup) !== change.before_revision) {
            throw new ProjectError(
              "PROJECT_RECOVERY_BACKUP_INVALID",
              "복구 사본의 해시가 작업 기록과 일치하지 않습니다.",
              { path: change.path },
            );
          }
          await atomicWrite(target.path, backup);
        }
      }
      manifest.status = "recovered";
      await writeManifest(operationRoot, manifest);
      return { ok: true, operation_id: operationId, status: "recovered" };
    } catch (error) {
      manifest.status = "recovery_required";
      manifest.error_code = error.code ?? "PROJECT_IO_ERROR";
      await writeManifest(operationRoot, manifest).catch(() => {});
      throw asProjectError(error);
    }
  });
}

export async function writeProjectTextFile({
  root,
  path,
  content,
  expectedRevision,
  programRoot,
}) {
  return applyProjectFileChanges({
    root,
    programRoot,
    changes: [{ path, action: "write", content, expectedRevision }],
  });
}

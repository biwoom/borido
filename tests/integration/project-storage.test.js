import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  applyProjectFileChanges,
  initializeProject,
  listProjectRecoveryOperations,
  newProjectSettings,
  readProjectTextFile,
  recoverProjectFileOperation,
  writeProjectTextFile,
} from "../../core/project/index.js";

const programRoot = fileURLToPath(new URL("../../", import.meta.url));

describe("W06 safe project file storage", () => {
  const sandboxes = [];

  afterEach(async () => {
    await Promise.all(
      sandboxes.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  async function project() {
    const sandbox = await mkdtemp(join(tmpdir(), "borido-w06-"));
    sandboxes.push(sandbox);
    const root = join(sandbox, "project");
    await initializeProject({
      root,
      programRoot,
      settings: newProjectSettings({
        siteName: "W06 저장 프로젝트",
        defaultLanguage: "ko",
        timezone: "Asia/Seoul",
      }),
    });
    return root;
  }

  it("round-trips UTF-8 and line endings with revision conflicts", async () => {
    const root = await project();
    const path = "content/pages/draft.md";
    const firstContent = "첫 줄\r\n둘째 줄 한글\r\n";
    await writeProjectTextFile({
      root,
      path,
      content: firstContent,
      expectedRevision: null,
      programRoot,
    });
    const first = await readProjectTextFile({ root, path, programRoot });
    expect(first.content).toBe(firstContent);

    const secondContent = "바뀐 줄\n끝\n";
    await writeProjectTextFile({
      root,
      path,
      content: secondContent,
      expectedRevision: first.revision,
      programRoot,
    });
    await expect(
      writeProjectTextFile({
        root,
        path,
        content: "낡은 편집 버퍼",
        expectedRevision: first.revision,
        programRoot,
      }),
    ).rejects.toMatchObject({ code: "PROJECT_FILE_REVISION_CONFLICT" });
    expect((await readProjectTextFile({ root, path, programRoot })).content).toBe(
      secondContent,
    );
  });

  it("rolls back all applied files when a later change fails", async () => {
    const root = await project();
    const firstPath = "content/pages/first.md";
    const secondPath = "content/pages/second.md";
    await applyProjectFileChanges({
      root,
      programRoot,
      changes: [
        { path: firstPath, content: "첫 원본\n", expectedRevision: null },
        { path: secondPath, content: "둘째 원본\n", expectedRevision: null },
      ],
    });
    const first = await readProjectTextFile({ root, path: firstPath, programRoot });
    const second = await readProjectTextFile({ root, path: secondPath, programRoot });
    const operationId = "00000000-0000-4000-8000-000000000006";

    await expect(
      applyProjectFileChanges({
        root,
        programRoot,
        operationId,
        changes: [
          {
            path: firstPath,
            content: "첫 변경\n",
            expectedRevision: first.revision,
          },
          {
            path: secondPath,
            content: "둘째 변경\n",
            expectedRevision: second.revision,
          },
        ],
        _beforeApply: ({ index }) => {
          if (index === 1) throw new Error("합성 실패");
        },
      }),
    ).rejects.toMatchObject({ code: "PROJECT_IO_ERROR" });

    expect((await readProjectTextFile({ root, path: firstPath, programRoot })).content)
      .toBe("첫 원본\n");
    expect((await readProjectTextFile({ root, path: secondPath, programRoot })).content)
      .toBe("둘째 원본\n");
    const manifest = JSON.parse(
      await readFile(
        join(root, ".borido", "recovery", operationId, "manifest.json"),
        "utf8",
      ),
    );
    expect(manifest.status).toBe("rolled_back");
  });

  it("serializes concurrent writes so only one stale revision can win", async () => {
    const root = await project();
    const path = "content/pages/concurrent.md";
    await writeProjectTextFile({
      root,
      path,
      content: "원본\n",
      expectedRevision: null,
      programRoot,
    });
    const current = await readProjectTextFile({ root, path, programRoot });
    const results = await Promise.allSettled([
      writeProjectTextFile({
        root,
        path,
        content: "첫 저장\n",
        expectedRevision: current.revision,
        programRoot,
      }),
      writeProjectTextFile({
        root,
        path,
        content: "둘째 저장\n",
        expectedRevision: current.revision,
        programRoot,
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("restores a completed operation only while its resulting revisions match", async () => {
    const root = await project();
    const path = "content/pages/recoverable.md";
    const result = await writeProjectTextFile({
      root,
      path,
      content: "복구 전 새 파일\n",
      expectedRevision: null,
      programRoot,
    });
    expect(await listProjectRecoveryOperations({ root, programRoot })).toContainEqual(
      expect.objectContaining({
        operation_id: result.operation_id,
        status: "completed",
      }),
    );

    await recoverProjectFileOperation({
      root,
      operationId: result.operation_id,
      programRoot,
    });
    await expect(
      readProjectTextFile({ root, path, programRoot }),
    ).rejects.toMatchObject({ code: "PROJECT_PATH_NOT_FOUND" });
    expect(await listProjectRecoveryOperations({ root, programRoot })).toContainEqual(
      expect.objectContaining({
        operation_id: result.operation_id,
        status: "recovered",
      }),
    );
  });

  it("does not recover over edits made after a completed operation", async () => {
    const root = await project();
    const path = "content/pages/recovery-conflict.md";
    const created = await writeProjectTextFile({
      root,
      path,
      content: "첫 저장\n",
      expectedRevision: null,
      programRoot,
    });
    const current = await readProjectTextFile({ root, path, programRoot });
    await writeProjectTextFile({
      root,
      path,
      content: "후속 편집\n",
      expectedRevision: current.revision,
      programRoot,
    });
    await expect(
      recoverProjectFileOperation({
        root,
        operationId: created.operation_id,
        programRoot,
      }),
    ).rejects.toMatchObject({ code: "PROJECT_RECOVERY_REVISION_CONFLICT" });
    expect((await readProjectTextFile({ root, path, programRoot })).content).toBe(
      "후속 편집\n",
    );
  });

  it("rejects output and program paths outside managed source folders", async () => {
    const root = await project();
    for (const path of ["dist/index.html", ".borido/secret", "../package.json"]) {
      await expect(
        writeProjectTextFile({
          root,
          path,
          content: "금지",
          expectedRevision: null,
          programRoot,
        }),
      ).rejects.toMatchObject({ code: "PROJECT_FILE_NOT_MANAGED" });
    }
  });
});

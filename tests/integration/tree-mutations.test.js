import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  createContent,
  createTreeRecord,
  deleteTreeRecord,
  indexProjectContent,
  inspectTreeDeletion,
  inspectTreeMove,
  moveTreeRecord,
  reorderTreeRecord,
  restoreTreeOperation,
} from "../../core/content/index.js";
import {
  initializeProject,
  newProjectSettings,
  readProjectTextFile,
} from "../../core/project/index.js";

const programRoot = fileURLToPath(new URL("../../", import.meta.url));

describe("W10 tree mutations and URL impact", () => {
  const sandboxes = [];

  afterEach(async () => {
    await Promise.all(
      sandboxes.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  async function project() {
    const sandbox = await mkdtemp(join(tmpdir(), "borido-w10-"));
    sandboxes.push(sandbox);
    const root = join(sandbox, "project");
    await initializeProject({
      root,
      programRoot,
      settings: newProjectSettings({
        siteName: "W10 트리 프로젝트",
        defaultLanguage: "ko",
        timezone: "Asia/Seoul",
      }),
    });
    const text = await createContent({
      root,
      type: "text",
      title: "트리 검증 경론",
      slug: "tree-text",
      programRoot,
    });
    const report = await indexProjectContent({ root });
    const areas = Object.fromEntries(
      report.index.records
        .filter((record) => record.type === "text_area" && record.text_id === text.id)
        .map((record) => [record.area, record]),
    );
    return { root, text, areas };
  }

  async function metadataRevision(root, record) {
    return (await readProjectTextFile({
      root,
      path: record.path,
      programRoot,
    })).revision;
  }

  it("creates and reorders nodes with revision protection", async () => {
    const { root, areas } = await project();
    const node = await createTreeRecord({
      root,
      parentId: areas.translation.id,
      type: "tree_node",
      title: "첫 구조",
      slug: "first-node",
      order: 20,
      nodeKind: "chapter",
      overview: "구조 개요\n",
      programRoot,
    });
    const revision = await metadataRevision(root, node);
    const reordered = await reorderTreeRecord({
      root,
      id: node.id,
      order: 5,
      expectedMetadataRevision: revision,
      programRoot,
    });
    expect(reordered.order).toBe(5);
    await expect(
      reorderTreeRecord({
        root,
        id: node.id,
        order: 30,
        expectedMetadataRevision: revision,
        programRoot,
      }),
    ).rejects.toMatchObject({ code: "PROJECT_FILE_REVISION_CONFLICT" });
  });

  it("keeps URLs unchanged within one area and restores the move", async () => {
    const { root, areas } = await project();
    const first = await createTreeRecord({
      root,
      parentId: areas.translation.id,
      type: "tree_node",
      title: "첫 부모",
      slug: "first-parent",
      order: 10,
      nodeKind: "chapter",
      programRoot,
    });
    const second = await createTreeRecord({
      root,
      parentId: areas.translation.id,
      type: "tree_node",
      title: "둘째 부모",
      slug: "second-parent",
      order: 20,
      nodeKind: "chapter",
      programRoot,
    });
    const document = await createTreeRecord({
      root,
      parentId: first.id,
      type: "text_document",
      title: "이동 문서",
      slug: "moving-document",
      order: 10,
      content: "본문\n",
      programRoot,
    });
    const impact = await inspectTreeMove({
      root,
      id: document.id,
      newParentId: second.id,
      programRoot,
    });
    expect(impact.affected).toEqual([
      expect.objectContaining({
        old_url: "/texts/tree-text/translation/moving-document/",
        new_url: "/texts/tree-text/translation/moving-document/",
        url_changed: false,
      }),
    ]);
    const moved = await moveTreeRecord({
      root,
      id: document.id,
      newParentId: second.id,
      expectedMetadataRevision: impact.metadata_revision,
      expectedImpactRevision: impact.impact_revision,
      programRoot,
    });
    await expect(
      readFile(join(root, "config", "url-history.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect((await indexProjectContent({ root })).index.records.find(
      (record) => record.id === document.id,
    )?.parent_id).toBe(second.id);

    await restoreTreeOperation({
      root,
      operationId: moved.operation_id,
      programRoot,
    });
    expect((await indexProjectContent({ root })).index.records.find(
      (record) => record.id === document.id,
    )?.parent_id).toBe(first.id);
  });

  it("records every changed descendant URL across areas and reverses history", async () => {
    const { root, areas } = await project();
    const node = await createTreeRecord({
      root,
      parentId: areas.translation.id,
      type: "tree_node",
      title: "옮길 구조",
      slug: "movable-node",
      order: 10,
      nodeKind: "chapter",
      programRoot,
    });
    const document = await createTreeRecord({
      root,
      parentId: node.id,
      type: "text_document",
      title: "하위 문서",
      slug: "child-document",
      order: 10,
      content: "하위 본문\n",
      programRoot,
    });
    const impact = await inspectTreeMove({
      root,
      id: node.id,
      newParentId: areas.original.id,
      programRoot,
    });
    expect(impact.affected).toHaveLength(2);
    expect(impact.affected.every((item) => item.url_changed)).toBe(true);
    const moved = await moveTreeRecord({
      root,
      id: node.id,
      newParentId: areas.original.id,
      expectedMetadataRevision: impact.metadata_revision,
      expectedImpactRevision: impact.impact_revision,
      programRoot,
    });
    const history = JSON.parse(
      await readFile(join(root, "config", "url-history.json"), "utf8"),
    );
    expect(history.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "/texts/tree-text/translation/nodes/movable-node/",
          target_id: node.id,
        }),
        expect.objectContaining({
          from: "/texts/tree-text/translation/child-document/",
          target_id: document.id,
        }),
      ]),
    );

    await restoreTreeOperation({ root, operationId: moved.operation_id, programRoot });
    await expect(
      readFile(join(root, "config", "url-history.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("moves a document across texts without changing its stable ID", async () => {
    const { root, areas } = await project();
    const document = await createTreeRecord({
      root,
      parentId: areas.translation.id,
      type: "text_document",
      title: "경론 간 이동 문서",
      slug: "cross-text-document",
      order: 10,
      content: "경론 간 이동 본문\n",
      programRoot,
    });
    const secondText = await createContent({
      root,
      type: "text",
      title: "둘째 경론",
      slug: "second-text",
      programRoot,
    });
    const secondOriginal = (await indexProjectContent({ root })).index.records.find(
      (record) =>
        record.type === "text_area" &&
        record.text_id === secondText.id &&
        record.area === "original",
    );
    const impact = await inspectTreeMove({
      root,
      id: document.id,
      newParentId: secondOriginal.id,
      programRoot,
    });
    expect(impact.affected).toContainEqual(
      expect.objectContaining({
        id: document.id,
        old_url: "/texts/tree-text/translation/cross-text-document/",
        new_url: "/texts/second-text/original/cross-text-document/",
      }),
    );
    const moved = await moveTreeRecord({
      root,
      id: document.id,
      newParentId: secondOriginal.id,
      expectedMetadataRevision: impact.metadata_revision,
      expectedImpactRevision: impact.impact_revision,
      programRoot,
    });
    expect((await indexProjectContent({ root })).index.records).toContainEqual(
      expect.objectContaining({
        id: document.id,
        text_id: secondText.id,
        area: "original",
      }),
    );

    await restoreTreeOperation({ root, operationId: moved.operation_id, programRoot });
    expect((await indexProjectContent({ root })).index.records).toContainEqual(
      expect.objectContaining({
        id: document.id,
        area: "translation",
      }),
    );
  });

  it("rolls back an interrupted recovery and can retry it safely", async () => {
    const { root, areas } = await project();
    const document = await createTreeRecord({
      root,
      parentId: areas.translation.id,
      type: "text_document",
      title: "복구 재시도 문서",
      slug: "recovery-retry",
      order: 10,
      content: "복구 재시도 본문\n",
      programRoot,
    });
    const impact = await inspectTreeMove({
      root,
      id: document.id,
      newParentId: areas.original.id,
      programRoot,
    });
    const moved = await moveTreeRecord({
      root,
      id: document.id,
      newParentId: areas.original.id,
      expectedMetadataRevision: impact.metadata_revision,
      expectedImpactRevision: impact.impact_revision,
      programRoot,
    });

    await expect(
      restoreTreeOperation({
        root,
        operationId: moved.operation_id,
        _beforeRecoveryCommit: () => {
          throw new Error("합성 복구 기록 실패");
        },
        programRoot,
      }),
    ).rejects.toThrow("합성 복구 기록 실패");
    expect((await indexProjectContent({ root })).index.records.find(
      (record) => record.id === document.id,
    )?.parent_id).toBe(areas.original.id);
    expect(JSON.parse(await readFile(
      join(root, ".borido", "tree-operations", moved.operation_id, "manifest.json"),
      "utf8",
    )).status).toBe("completed");

    await restoreTreeOperation({ root, operationId: moved.operation_id, programRoot });
    expect((await indexProjectContent({ root })).index.records.find(
      (record) => record.id === document.id,
    )?.parent_id).toBe(areas.translation.id);
  });

  it("rejects moving a structure under its own descendant", async () => {
    const { root, areas } = await project();
    const parent = await createTreeRecord({
      root,
      parentId: areas.translation.id,
      type: "tree_node",
      title: "상위",
      slug: "parent-node",
      order: 10,
      nodeKind: "chapter",
      programRoot,
    });
    const child = await createTreeRecord({
      root,
      parentId: parent.id,
      type: "tree_node",
      title: "하위",
      slug: "child-node",
      order: 10,
      nodeKind: "section",
      programRoot,
    });
    await expect(
      inspectTreeMove({ root, id: parent.id, newParentId: child.id, programRoot }),
    ).rejects.toMatchObject({ code: "TREE_MOVE_INTO_DESCENDANT" });
  });

  it("rolls back injected move and delete failures without losing the tree", async () => {
    const { root, areas } = await project();
    const document = await createTreeRecord({
      root,
      parentId: areas.translation.id,
      type: "text_document",
      title: "실패 복구 문서",
      slug: "rollback-document",
      order: 10,
      content: "보존 본문\n",
      programRoot,
    });
    const moveImpact = await inspectTreeMove({
      root,
      id: document.id,
      newParentId: areas.original.id,
      programRoot,
    });
    await expect(
      moveTreeRecord({
        root,
        id: document.id,
        newParentId: areas.original.id,
        expectedMetadataRevision: moveImpact.metadata_revision,
        expectedImpactRevision: moveImpact.impact_revision,
        _afterMove: () => {
          throw new Error("합성 이동 실패");
        },
        programRoot,
      }),
    ).rejects.toThrow("합성 이동 실패");
    expect((await indexProjectContent({ root })).index.records.find(
      (record) => record.id === document.id,
    )?.parent_id).toBe(areas.translation.id);
    await expect(
      readFile(join(root, "config", "url-history.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const deleteImpact = await inspectTreeDeletion({
      root,
      id: document.id,
      programRoot,
    });
    await expect(
      deleteTreeRecord({
        root,
        id: document.id,
        expectedMetadataRevision: deleteImpact.metadata_revision,
        expectedImpactRevision: deleteImpact.impact_revision,
        _afterDelete: () => {
          throw new Error("합성 삭제 실패");
        },
        programRoot,
      }),
    ).rejects.toThrow("합성 삭제 실패");
    expect((await indexProjectContent({ root })).index.records).toContainEqual(
      expect.objectContaining({ id: document.id }),
    );
  });

  it("blocks referenced deletion, preserves URL tombstones, and restores the tree", async () => {
    const { root, areas } = await project();
    const target = await createTreeRecord({
      root,
      parentId: areas.translation.id,
      type: "text_document",
      title: "삭제 대상",
      slug: "delete-target",
      order: 10,
      content: "삭제 대상 본문\n",
      programRoot,
    });
    const source = await createTreeRecord({
      root,
      parentId: areas.research.id,
      type: "text_document",
      title: "참조 문서",
      slug: "reference-source",
      order: 10,
      content: "참조 본문\n",
      relatedDocuments: [target.id],
      programRoot,
    });
    const blocked = await inspectTreeDeletion({ root, id: target.id, programRoot });
    expect(blocked.references).toContainEqual(
      expect.objectContaining({ source_id: source.id, target_id: target.id }),
    );
    await expect(
      deleteTreeRecord({
        root,
        id: target.id,
        expectedMetadataRevision: blocked.metadata_revision,
        expectedImpactRevision: blocked.impact_revision,
        programRoot,
      }),
    ).rejects.toMatchObject({ code: "TREE_DELETE_REFERENCED" });

    const sourceImpact = await inspectTreeDeletion({ root, id: source.id, programRoot });
    await deleteTreeRecord({
      root,
      id: source.id,
      expectedMetadataRevision: sourceImpact.metadata_revision,
      expectedImpactRevision: sourceImpact.impact_revision,
      programRoot,
    });
    const targetImpact = await inspectTreeDeletion({ root, id: target.id, programRoot });
    const deleted = await deleteTreeRecord({
      root,
      id: target.id,
      expectedMetadataRevision: targetImpact.metadata_revision,
      expectedImpactRevision: targetImpact.impact_revision,
      programRoot,
    });
    await expect(
      createTreeRecord({
        root,
        parentId: areas.translation.id,
        type: "text_document",
        title: "URL 재사용",
        slug: "delete-target",
        order: 20,
        content: "새 본문\n",
        programRoot,
      }),
    ).rejects.toMatchObject({ code: "TREE_URL_TOMBSTONE_CONFLICT" });

    await restoreTreeOperation({
      root,
      operationId: deleted.operation_id,
      programRoot,
    });
    expect((await indexProjectContent({ root })).index.records).toContainEqual(
      expect.objectContaining({ id: target.id, parent_id: areas.translation.id }),
    );
  });
});

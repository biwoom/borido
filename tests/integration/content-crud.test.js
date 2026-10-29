import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  createContent,
  deleteContent,
  getContentProject,
  inspectContentDeletion,
  readContent,
  restoreDeletedContent,
  updateContent,
} from "../../core/content/index.js";
import {
  initializeProject,
  newProjectSettings,
} from "../../core/project/index.js";

const programRoot = fileURLToPath(new URL("../../", import.meta.url));

describe("W08 top-level content CRUD and references", () => {
  const sandboxes = [];

  afterEach(async () => {
    await Promise.all(
      sandboxes.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  async function project() {
    const sandbox = await mkdtemp(join(tmpdir(), "borido-w08-"));
    sandboxes.push(sandbox);
    const root = join(sandbox, "project");
    await initializeProject({
      root,
      programRoot,
      settings: newProjectSettings({
        siteName: "W08 콘텐츠 프로젝트",
        defaultLanguage: "ko",
        timezone: "Asia/Seoul",
      }),
    });
    return root;
  }

  it("creates all four top-level types as drafts with their required files", async () => {
    const root = await project();
    const text = await createContent({
      root,
      type: "text",
      title: "합성 경론",
      slug: "synthetic-text",
      overview: "# 개요\n",
      programRoot,
    });
    const story = await createContent({
      root,
      type: "story",
      title: "합성 이야기",
      slug: "synthetic-story",
      body: "# 이야기\n",
      programRoot,
    });
    const blog = await createContent({
      root,
      type: "blog",
      title: "합성 글",
      slug: "synthetic-post",
      body: "# 글\n",
      programRoot,
    });
    const page = await createContent({
      root,
      type: "page",
      title: "합성 페이지",
      slug: "synthetic-page",
      body: "# 페이지\n",
      programRoot,
    });

    for (const content of [text, story, blog, page]) {
      expect(content.record.status).toBe("draft");
      expect(content.record.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
    }
    expect(text.record.canon).toMatchObject({
      canon_id: "taisho",
      verification_status: "unverified",
    });
    expect(text.body).toBe("# 개요\n");
    expect(story.body).toBe("# 이야기\n");
    expect(blog.path).toMatch(/^content\/blog\/\d{4}\/synthetic-post\/meta\.json$/u);
    expect(page.body).toBe("# 페이지\n");

    const report = await getContentProject({ root });
    expect(report.ok).toBe(true);
    expect(report.summary.records).toBe(7);
    expect(
      report.index.records
        .filter((record) => record.text_id === text.id && record.type === "text_area")
        .map((record) => record.area)
        .sort(),
    ).toEqual(["original", "research", "translation"]);
  });

  it("updates metadata and body atomically while keeping identity fields immutable", async () => {
    const root = await project();
    const created = await createContent({
      root,
      type: "page",
      title: "처음 제목",
      slug: "stable-page",
      body: "처음 본문\n",
      programRoot,
    });
    const updated = await updateContent({
      root,
      id: created.id,
      changes: { title: "바뀐 제목", menu_visible: true },
      body: "바뀐 본문\n",
      expectedRevisions: created.revisions,
      programRoot,
    });

    expect(updated.record).toMatchObject({
      id: created.record.id,
      slug: created.record.slug,
      created_at: created.record.created_at,
      title: "바뀐 제목",
      menu_visible: true,
    });
    expect(updated.body).toBe("바뀐 본문\n");
    await expect(
      updateContent({
        root,
        id: created.id,
        changes: { title: "낡은 수정" },
        expectedRevisions: created.revisions,
        programRoot,
      }),
    ).rejects.toMatchObject({ code: "PROJECT_FILE_REVISION_CONFLICT" });
    await expect(
      updateContent({
        root,
        id: created.id,
        changes: { slug: "changed-page" },
        expectedRevisions: updated.revisions,
        programRoot,
      }),
    ).rejects.toMatchObject({ code: "CONTENT_IMMUTABLE_FIELD" });
  });

  it("rejects missing and wrong-type related content references", async () => {
    const root = await project();
    await expect(
      createContent({
        root,
        type: "text",
        title: "깨진 참조",
        slug: "broken-reference",
        fields: { related_texts: ["10000000-0000-4000-8000-000000000001"] },
        programRoot,
      }),
    ).rejects.toMatchObject({ code: "CONTENT_REFERENCE_INVALID" });

    const page = await createContent({
      root,
      type: "page",
      title: "페이지",
      slug: "reference-page",
      programRoot,
    });
    await expect(
      createContent({
        root,
        type: "text",
        title: "잘못된 유형 참조",
        slug: "wrong-reference-type",
        fields: { related_texts: [page.id] },
        programRoot,
      }),
    ).rejects.toMatchObject({ code: "CONTENT_REFERENCE_INVALID" });
  });

  it("reports deletion impact, blocks incoming references, and restores the exact tree", async () => {
    const root = await project();
    const target = await createContent({
      root,
      type: "text",
      title: "삭제 대상",
      slug: "delete-target",
      overview: "보존할 개요\n",
      programRoot,
    });
    const source = await createContent({
      root,
      type: "text",
      title: "참조 원본",
      slug: "reference-source",
      fields: { related_texts: [target.id] },
      programRoot,
    });
    const blockedImpact = await inspectContentDeletion({
      root,
      id: target.id,
      programRoot,
    });
    expect(blockedImpact.descendant_ids).toHaveLength(3);
    expect(blockedImpact.references).toContainEqual(
      expect.objectContaining({ source_id: source.id, field: "related_texts" }),
    );
    await expect(
      deleteContent({
        root,
        id: target.id,
        expectedMetadataRevision: blockedImpact.metadata_revision,
        expectedImpactRevision: blockedImpact.impact_revision,
        programRoot,
      }),
    ).rejects.toMatchObject({ code: "CONTENT_DELETE_REFERENCED" });

    const sourceCurrent = await readContent({ root, id: source.id, programRoot });
    await updateContent({
      root,
      id: source.id,
      changes: { related_texts: [] },
      expectedRevisions: sourceCurrent.revisions,
      programRoot,
    });
    const impact = await inspectContentDeletion({ root, id: target.id, programRoot });
    const deletion = await deleteContent({
      root,
      id: target.id,
      expectedMetadataRevision: impact.metadata_revision,
      expectedImpactRevision: impact.impact_revision,
      programRoot,
    });
    await expect(
      readContent({ root, id: target.id, programRoot }),
    ).rejects.toMatchObject({ code: "CONTENT_NOT_FOUND" });
    await expect(
      createContent({
        root,
        type: "page",
        title: "삭제 ID 재사용 시도",
        slug: "reused-deleted-id",
        idFactory: () => target.id,
        programRoot,
      }),
    ).rejects.toMatchObject({ code: "CONTENT_ID_CONFLICT" });

    const restored = await restoreDeletedContent({
      root,
      operationId: deletion.operation_id,
      programRoot,
    });
    expect(restored.record.id).toBe(target.id);
    expect(restored.body).toBe("보존할 개요\n");
    expect((await getContentProject({ root })).summary.records).toBe(8);
  });

  it("rejects the reserved text slug before writing files", async () => {
    const root = await project();
    await expect(
      createContent({
        root,
        type: "text",
        title: "예약 경로",
        slug: "categories",
        programRoot,
      }),
    ).rejects.toMatchObject({ code: "CONTENT_SLUG_RESERVED" });
    expect((await getContentProject({ root })).summary.records).toBe(0);
  });

  it("warns instead of exposing a draft optional target from published content", async () => {
    const root = await project();
    const target = await createContent({
      root,
      type: "text",
      title: "비공개 관련 경론",
      slug: "draft-related-text",
      programRoot,
    });
    const source = await createContent({
      root,
      type: "text",
      title: "공개 경론",
      slug: "published-source-text",
      fields: { related_texts: [target.id] },
      programRoot,
    });
    await updateContent({
      root,
      id: source.id,
      changes: { status: "published" },
      expectedRevisions: source.revisions,
      programRoot,
    });

    const report = await getContentProject({ root });
    expect(report.ok).toBe(true);
    expect(report.references_ok).toBe(true);
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "warning",
        code: "REFERENCE_TARGET_NOT_PUBLIC",
        record_id: source.id,
      }),
    );
  });
});

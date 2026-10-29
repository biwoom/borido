import { describe, expect, it } from "vitest";

import { buildTextTrees } from "../../core/content/index.js";

function record({
  id,
  type,
  title,
  slug,
  order = null,
  parentId = null,
  textId = null,
  area = null,
  bodyFile = null,
}) {
  return {
    id,
    type,
    title,
    slug,
    status: "draft",
    order,
    parent_id: parentId,
    text_id: textId,
    area,
    path: `${id}.json`,
    data: { body_file: bodyFile },
  };
}

describe("W09-B independent text trees", () => {
  it("keeps three differently shaped areas independent and stably sorted", () => {
    const textId = "10000000-0000-4000-8000-000000000001";
    const translationId = "10000000-0000-4000-8000-000000000002";
    const originalId = "10000000-0000-4000-8000-000000000003";
    const researchId = "10000000-0000-4000-8000-000000000004";
    const chapterId = "10000000-0000-4000-8000-000000000005";
    const records = [
      record({ id: textId, type: "text", title: "경론", slug: "text", textId }),
      record({
        id: translationId,
        type: "text_area",
        title: "번역",
        slug: "translation",
        order: 10,
        parentId: textId,
        textId,
        area: "translation",
      }),
      record({
        id: originalId,
        type: "text_area",
        title: "원문",
        slug: "original",
        order: 20,
        parentId: textId,
        textId,
        area: "original",
      }),
      record({
        id: researchId,
        type: "text_area",
        title: "연구",
        slug: "research",
        order: 30,
        parentId: textId,
        textId,
        area: "research",
      }),
      record({
        id: chapterId,
        type: "tree_node",
        title: "번역 장",
        slug: "chapter",
        order: 10,
        parentId: translationId,
        textId,
        area: "translation",
        bodyFile: "_index.md",
      }),
      record({
        id: "10000000-0000-4000-8000-000000000009",
        type: "text_document",
        title: "둘째 번역",
        slug: "second",
        order: 20,
        parentId: chapterId,
        textId,
        area: "translation",
        bodyFile: "body.md",
      }),
      record({
        id: "10000000-0000-4000-8000-000000000008",
        type: "text_document",
        title: "첫째 번역",
        slug: "first",
        order: 20,
        parentId: chapterId,
        textId,
        area: "translation",
        bodyFile: "body.md",
      }),
      record({
        id: "10000000-0000-4000-8000-000000000006",
        type: "text_document",
        title: "원문",
        slug: "source",
        order: 10,
        parentId: originalId,
        textId,
        area: "original",
        bodyFile: "body.md",
      }),
    ];

    const [tree] = buildTextTrees(records, {
      [textId]: "경론 개요",
      [chapterId]: "장 개요",
    });
    expect(tree.overview).toBe("경론 개요");
    expect(tree.areas.translation.children[0]).toMatchObject({
      id: chapterId,
      overview: "장 개요",
    });
    expect(
      tree.areas.translation.children[0].children.map((item) => item.id),
    ).toEqual([
      "10000000-0000-4000-8000-000000000008",
      "10000000-0000-4000-8000-000000000009",
    ]);
    expect(tree.areas.original.children).toHaveLength(1);
    expect(tree.areas.research.children).toEqual([]);
  });
});

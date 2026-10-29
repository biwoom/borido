import { describe, expect, it } from "vitest";

import {
  createSiteSettings,
  normalizeBasePath,
  parsePublicUrl,
  validateSiteSettings,
} from "../../core/project/index.js";

describe("W02 site settings contract", () => {
  it("separates a public origin and path without inferring repositories", () => {
    expect(
      createSiteSettings({
        siteName: "보리도 자료실",
        defaultLanguage: "ko",
        timezone: "Asia/Seoul",
        publicUrl: "https://biwoom.github.io/borido/",
      }),
    ).toEqual({
      schema_version: 1,
      site_name: "보리도 자료실",
      description: "",
      default_language: "ko",
      author_name: "",
      license: "",
      timezone: "Asia/Seoul",
      base_url: "https://biwoom.github.io",
      base_path: "/borido/",
      source_repository: null,
      deployment: null,
    });
  });

  it("supports an offline project with no public or GitHub settings", () => {
    const settings = createSiteSettings({
      siteName: "오프라인 프로젝트",
      defaultLanguage: "ko-KR",
      timezone: "UTC",
    });

    expect(settings.base_url).toBeNull();
    expect(settings.base_path).toBe("/");
    expect(settings.source_repository).toBeNull();
    expect(settings.deployment).toBeNull();
  });

  it("keeps source and deployment repositories separate from the public URL", () => {
    const settings = createSiteSettings({
      siteName: "분리 설정",
      defaultLanguage: "ko",
      timezone: "Asia/Seoul",
      publicUrl: "https://example.org/library/",
      sourceRepository: {
        repository_url: "https://github.com/example/private-source.git",
        branch: "main",
        public_links: false,
      },
      deployment: {
        repository_url: "https://github.com/example/public-site.git",
        branch: "gh-pages",
      },
    });

    expect(settings.base_url).toBe("https://example.org");
    expect(settings.source_repository.repository_url).toContain("private-source");
    expect(settings.deployment.repository_url).toContain("public-site");
  });

  it("validates and preserves optional common media asset IDs", () => {
    const id = "20000000-0000-4000-8000-000000000001";
    const settings = createSiteSettings({
      siteName: "공통 자산 설정",
      defaultLanguage: "ko",
      timezone: "Asia/Seoul",
      commonAssetIds: [id],
    });
    expect(settings.common_asset_ids).toEqual([id]);
    expect(validateSiteSettings(settings).settings.common_asset_ids).toEqual([id]);
    expect(() => createSiteSettings({
      siteName: "잘못된 공통 자산",
      defaultLanguage: "ko",
      timezone: "Asia/Seoul",
      commonAssetIds: ["not-uuid"],
    })).toThrow(/UUID v4/);
  });

  it("rejects credentials embedded in repository URLs", () => {
    expect(() =>
      createSiteSettings({
        siteName: "비밀 거절",
        defaultLanguage: "ko",
        timezone: "Asia/Seoul",
        deployment: {
          repository_url: "https://user:token@github.com/example/site.git",
          branch: "gh-pages",
        },
      }),
    ).toThrow(/인증 비밀/);
  });

  it("normalizes safe prefixes and rejects ambiguous paths", () => {
    expect(normalizeBasePath("borido")).toBe("/borido/");
    expect(normalizeBasePath("/library/texts/")).toBe("/library/texts/");
    expect(() => normalizeBasePath("/a//b/")).toThrow(/빈 경로/);
    expect(() => normalizeBasePath("/../private/")).toThrow(/안전한 URL/);
    expect(() => normalizeBasePath("/%2e%2e/private/")).toThrow(/우회 경로/);
  });

  it("rejects credentials, query strings, and hashes in public URLs", () => {
    expect(() => parsePublicUrl("https://user@example.com/site/")).toThrow(
      /HTTP\(S\)/,
    );
    expect(() => parsePublicUrl("https://example.com/site/?draft=1")).toThrow(
      /HTTP\(S\)/,
    );
    expect(() => parsePublicUrl("https://example.com/site/#private")).toThrow(
      /HTTP\(S\)/,
    );
  });

  it("preserves unknown fields read-only and rejects secret fields", () => {
    const settings = {
      ...createSiteSettings({
        siteName: "이전 프로젝트",
        defaultLanguage: "ko",
        timezone: "Asia/Seoul",
      }),
      future_option: { keep: true },
    };
    const result = validateSiteSettings(settings);

    expect(result.editable).toBe(false);
    expect(result.settings.future_option).toEqual({ keep: true });
    expect(result.diagnostics[0]).toMatchObject({
      code: "UNKNOWN_SITE_FIELD",
      field: "future_option",
    });
    expect(() =>
      validateSiteSettings({ ...settings, github_token: "do-not-store" }),
    ).toThrow(/인증 비밀/);
  });
});

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { startLocalServer } from "../../app/server/index.js";

test("creates a local project and preserves settings after restart", async ({ page }) => {
  const sandbox = await mkdtemp(join(tmpdir(), "borido-w04-browser-"));
  const root = join(sandbox, "reader-site");
  let local = await startLocalServer({ projectRoot: root });

  try {
    await page.goto(`${local.origin}/#session=${encodeURIComponent(local.sessionToken)}`);
    await expect(page.getByRole("heading", { name: "새 프로젝트 시작" })).toBeVisible();
    await expect(page.locator("#new-project-path")).toHaveText(root);

    await page.getByLabel("사이트명 필수").fill("선정의 길");
    await page.getByLabel("사이트 설명").fill("경론을 차분히 읽는 공간");
    await page.getByLabel("기본 언어 필수").fill("ko");
    await page.getByLabel("시간대 필수").fill("Asia/Seoul");
    await page.getByLabel("작성자 표시명").fill("담진");
    await page.getByLabel("라이선스").fill("CC BY 4.0");
    await page.getByLabel("전체 공개 URL").fill("https://example.github.io/borido-texts/");
    await page.getByRole("button", { name: "프로젝트 만들기" }).click();

    await expect(page.getByRole("heading", { name: "경론", exact: true })).toBeVisible();
    await expect(page.getByText("아직 등록된 경론이 없습니다")).toBeVisible();
    await expect(page.locator("#save-status")).toHaveText("저장됨");

    const settings = JSON.parse(await readFile(join(root, "config", "site.json"), "utf8"));
    expect(settings).toMatchObject({
      site_name: "선정의 길",
      base_url: "https://example.github.io",
      base_path: "/borido-texts/",
      source_repository: null,
      deployment: null,
    });

    await local.close();
    local = await startLocalServer({ projectRoot: root });
    await page.goto(`${local.origin}/#session=${encodeURIComponent(local.sessionToken)}`);
    await expect(page.getByRole("heading", { name: "사이트 설정" })).toBeVisible();
    await expect(page.getByLabel("사이트명 필수")).toHaveValue("선정의 길");
    await expect(page.getByLabel("전체 공개 URL")).toHaveValue(
      "https://example.github.io/borido-texts/",
    );

    await page.getByLabel("사이트 설명").fill("다시 열어도 보존되는 설명");
    await expect(page.locator("#save-status")).toHaveText("저장 필요");
    await page.getByRole("button", { name: "설정 저장" }).click();
    await expect(page.locator("#save-status")).toHaveText("저장됨");
    await page.reload();
    await expect(page.getByLabel("사이트 설명")).toHaveValue("다시 열어도 보존되는 설명");
  } finally {
    if (local.server.listening) await local.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("shows a safe instruction instead of the editor without a session", async ({ page }) => {
  const sandbox = await mkdtemp(join(tmpdir(), "borido-w04-session-"));
  const local = await startLocalServer({ projectRoot: join(sandbox, "new-site") });
  try {
    await page.goto(local.origin);
    await expect(
      page.getByRole("heading", { name: "로컬 세션 주소로 다시 열어주세요" }),
    ).toBeVisible();
    await expect(page.locator("#app-shell")).toBeHidden();
  } finally {
    await local.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("keeps the first-run layout within a narrow viewport", async ({ page }) => {
  const sandbox = await mkdtemp(join(tmpdir(), "borido-w04-mobile-"));
  const local = await startLocalServer({ projectRoot: join(sandbox, "new-site") });
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${local.origin}/#session=${encodeURIComponent(local.sessionToken)}`);
    await expect(page.getByRole("heading", { name: "새 프로젝트 시작" })).toBeVisible();
    const widths = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      page: document.documentElement.scrollWidth,
    }));
    expect(widths.page).toBe(widths.viewport);
    await expect(page.locator("#primary-nav")).toBeVisible();
  } finally {
    await local.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

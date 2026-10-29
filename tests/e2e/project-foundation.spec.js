import { expect, test } from "@playwright/test";

test("Playwright runner starts on the supported Node.js line", () => {
  expect(process.versions.node.split(".")[0]).toBe("24");
});

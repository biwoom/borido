import { describe, expect, it } from "vitest";

import {
  SUPPORTED_NODE_MAJOR,
  SUPPORTED_NPM_MAJOR,
  inspectEnvironment,
} from "../../scripts/check-environment.mjs";

describe("W01 development environment", () => {
  it("accepts the selected Node.js and npm major versions", () => {
    expect(
      inspectEnvironment({
        nodeVersion: `v${SUPPORTED_NODE_MAJOR}.22.2`,
        npmUserAgent: `npm/${SUPPORTED_NPM_MAJOR}.14.1 node/v24.22.2 darwin x64`,
      }),
    ).toEqual({
      nodeVersion: "v24.22.2",
      npmVersion: "11.14.1",
      errors: [],
    });
  });

  it("rejects unsupported Node.js and npm major versions", () => {
    const result = inspectEnvironment({
      nodeVersion: "v25.2.1",
      npmUserAgent: "npm/12.0.0 node/v25.2.1 darwin x64",
    });

    expect(result.errors).toHaveLength(2);
    expect(result.errors.join("\n")).toContain("Node.js 24.x");
    expect(result.errors.join("\n")).toContain("npm 11.x");
  });

  it("can be called directly with Node.js when npm metadata is absent", () => {
    expect(
      inspectEnvironment({ nodeVersion: "v24.22.2", npmUserAgent: null }),
    ).toEqual({
      nodeVersion: "v24.22.2",
      npmVersion: null,
      errors: [],
    });
  });
});

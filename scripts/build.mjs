#!/usr/bin/env node
import { buildProject } from "../core/build/index.js";
import { defaultProjectRoot, errorResponse } from "../core/project/index.js";

function usageError() {
  return {
    ok: false,
    error: {
      code: "INVALID_BUILD_COMMAND",
      message: "사용법: npm run build 또는 npm run build -- /absolute/user-project",
      details: {},
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some((argument) => argument.startsWith("-"))) {
    process.stdout.write(`${JSON.stringify(usageError(), null, 2)}\n`);
    process.exitCode = 2;
    return;
  }
  try {
    const report = await buildProject({ root: args[0] ?? defaultProjectRoot() });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify(errorResponse(error), null, 2)}\n`);
    process.exitCode = 2;
  }
}

await main();

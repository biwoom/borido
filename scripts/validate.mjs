#!/usr/bin/env node
import { indexProjectContent } from "../core/content/index.js";
import { errorResponse } from "../core/project/index.js";

function usageError() {
  return {
    ok: false,
    error: {
      code: "INVALID_VALIDATE_COMMAND",
      message: "사용법: npm run validate -- /absolute/user-project",
      details: {},
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0].startsWith("-")) {
    process.stdout.write(`${JSON.stringify(usageError(), null, 2)}\n`);
    process.exitCode = 2;
    return;
  }
  try {
    const report = await indexProjectContent({ root: args[0] });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify(errorResponse(error), null, 2)}\n`);
    process.exitCode = 2;
  }
}

await main();

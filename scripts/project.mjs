#!/usr/bin/env node
import process from "node:process";

import {
  errorResponse,
  initializeProject,
  newProjectSettings,
  openProject,
} from "../core/project/index.js";

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!key.startsWith("--") || index + 1 >= args.length) {
      throw new Error(`잘못된 옵션: ${key}`);
    }
    options[key.slice(2)] = args[index + 1];
    index += 1;
  }
  return options;
}

async function run() {
  const [command, root, ...rest] = process.argv.slice(2);
  if (!command || !root || !["init", "open"].includes(command)) {
    throw new Error(
      "사용법: npm run project -- init <root> --name <name> --language <tag> --timezone <iana> [--public-url <url>] 또는 npm run project -- open <root>",
    );
  }

  if (command === "open") return openProject({ root });

  const options = parseOptions(rest);
  const settings = newProjectSettings({
    siteName: options.name,
    description: options.description ?? "",
    defaultLanguage: options.language,
    authorName: options.author ?? "",
    license: options.license ?? "",
    timezone: options.timezone,
    publicUrl: options["public-url"] ?? null,
  });
  return initializeProject({ root, settings });
}

try {
  const result = await run();
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  const response =
    error instanceof Error && !error.code
      ? {
          ok: false,
          error: { code: "INVALID_COMMAND", message: error.message, details: {} },
        }
      : errorResponse(error);
  console.error(JSON.stringify(response, null, 2));
  process.exitCode = 1;
}

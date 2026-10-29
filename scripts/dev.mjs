#!/usr/bin/env node
import process from "node:process";

import { startLocalServer } from "../app/server/index.js";
import { errorResponse } from "../core/project/index.js";

function parseOptions(args) {
  const options = {};
  const allowed = new Set(["project", "port"]);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    const name = flag?.startsWith("--") ? flag.slice(2) : null;
    if (!name || !allowed.has(name) || value === undefined || value.startsWith("--")) {
      throw new Error(`잘못된 서버 옵션: ${flag ?? "(없음)"}`);
    }
    if (Object.hasOwn(options, name)) {
      throw new Error(`중복 서버 옵션: --${name}`);
    }
    options[name] = value;
  }
  return options;
}

try {
  const options = parseOptions(process.argv.slice(2));
  const projectRoot = options.project;
  const portValue = options.port ?? null;
  if (!projectRoot) throw new Error("--project <path>가 필요합니다.");
  const port = portValue === null ? 0 : Number(portValue);
  const local = await startLocalServer({ projectRoot, port });
  console.log(
    JSON.stringify(
      {
        ok: true,
        origin: local.origin,
        project_root: local.projectRoot,
        mode: local.mode,
        session_token: local.sessionToken,
        url: `${local.origin}/#session=${encodeURIComponent(local.sessionToken)}`,
      },
      null,
      2,
    ),
  );

  const close = async () => {
    await local.close();
    process.exit(0);
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
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

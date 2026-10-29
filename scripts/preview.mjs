#!/usr/bin/env node
import { startPreviewServer } from "../core/preview/server.js";
import { defaultProjectRoot, errorResponse } from "../core/project/index.js";

function parseArguments(args) {
  let root = defaultProjectRoot();
  let port = 0;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--project" && args[index + 1]) root = args[++index];
    else if (argument === "--port" && /^\d+$/u.test(args[index + 1] ?? "")) port = Number(args[++index]);
    else throw new Error("usage");
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("usage");
  return { root, port };
}

try {
  const options = parseArguments(process.argv.slice(2));
  const preview = await startPreviewServer(options);
  process.stdout.write(`${JSON.stringify({ ok: true, url: preview.url, root: preview.root, dist: preview.dist })}\n`);
  const stop = async () => {
    await preview.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
} catch (error) {
  if (error.message === "usage") {
    process.stdout.write(`${JSON.stringify({ ok: false, error: { code: "INVALID_PREVIEW_COMMAND", message: "사용법: npm run preview -- [--project <path>] [--port <0-65535>]", details: {} } }, null, 2)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(errorResponse(error), null, 2)}\n`);
  }
  process.exitCode = 2;
}

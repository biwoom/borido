import process from "node:process";
import { fileURLToPath } from "node:url";

export const SUPPORTED_NODE_MAJOR = 24;
export const SUPPORTED_NPM_MAJOR = 11;

function major(version) {
  const match = String(version).match(/^(?:v)?(\d+)\./);
  return match ? Number(match[1]) : null;
}

export function inspectEnvironment({
  nodeVersion = process.version,
  npmUserAgent = process.env.npm_config_user_agent,
} = {}) {
  const nodeMajor = major(nodeVersion);
  const npmVersion = npmUserAgent?.match(/(?:^|\s)npm\/([^\s]+)/)?.[1] ?? null;
  const npmMajor = npmVersion ? major(npmVersion) : null;
  const errors = [];

  if (nodeMajor !== SUPPORTED_NODE_MAJOR) {
    errors.push(
      `Node.js ${SUPPORTED_NODE_MAJOR}.x LTS가 필요합니다. 현재 버전: ${nodeVersion}`,
    );
  }

  if (npmVersion && npmMajor !== SUPPORTED_NPM_MAJOR) {
    errors.push(
      `npm ${SUPPORTED_NPM_MAJOR}.x가 필요합니다. 현재 버전: ${npmVersion}`,
    );
  }

  return { nodeVersion, npmVersion, errors };
}

export function main() {
  const result = inspectEnvironment();

  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(`환경 오류: ${error}`);
    process.exitCode = 1;
    return;
  }

  const npm = result.npmVersion ? `, npm ${result.npmVersion}` : "";
  console.log(`보리도 개발 환경 확인: Node.js ${result.nodeVersion}${npm}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

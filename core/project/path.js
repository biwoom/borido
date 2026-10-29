import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { ProjectError } from "./errors.js";

function isInside(root, candidate) {
  const relation = relative(root, candidate);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function validateRelativePath(value) {
  if (typeof value !== "string" || value === "") {
    throw new ProjectError(
      "INVALID_PROJECT_PATH",
      "프로젝트 상대 경로를 명시해야 합니다.",
    );
  }
  if (
    isAbsolute(value) ||
    value.includes("\\") ||
    value.includes("\0") ||
    /%2f|%5c|%2e|%00/i.test(value)
  ) {
    throw new ProjectError(
      "INVALID_PROJECT_PATH",
      "절대 경로, 인코딩 우회 또는 역슬래시는 허용하지 않습니다.",
    );
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new ProjectError(
      "INVALID_PROJECT_PATH",
      "프로젝트 경로에 빈 구간이나 상위 경로를 넣을 수 없습니다.",
    );
  }
  return segments.join("/");
}

export async function resolveProjectPath(
  projectRoot,
  projectRelativePath,
  { mustExist = true } = {},
) {
  const root = await realpath(resolve(projectRoot));
  const safeRelativePath = validateRelativePath(projectRelativePath);
  const candidate = join(root, safeRelativePath);

  if (!isInside(root, candidate)) {
    throw new ProjectError(
      "PROJECT_PATH_OUTSIDE_ROOT",
      "프로젝트 루트 밖의 경로는 사용할 수 없습니다.",
    );
  }

  if (mustExist) {
    let actual;
    try {
      actual = await realpath(candidate);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new ProjectError(
          "PROJECT_PATH_NOT_FOUND",
          "프로젝트 상대 경로가 존재하지 않습니다.",
          { path: safeRelativePath },
        );
      }
      throw error;
    }
    if (!isInside(root, actual)) {
      throw new ProjectError(
        "PROJECT_PATH_SYMLINK_ESCAPE",
        "심볼릭 링크가 프로젝트 루트 밖을 가리킵니다.",
        { path: safeRelativePath },
      );
    }
    return { root, path: actual, relativePath: safeRelativePath };
  }

  const parentRelative = safeRelativePath.split("/").slice(0, -1).join("/");
  const parent = parentRelative ? join(root, parentRelative) : root;
  let actualParent;
  try {
    actualParent = await realpath(parent);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new ProjectError(
        "PROJECT_PARENT_PATH_NOT_FOUND",
        "새 경로의 프로젝트 내부 상위 폴더가 존재하지 않습니다.",
        { path: parentRelative },
      );
    }
    throw error;
  }
  if (!isInside(root, actualParent)) {
    throw new ProjectError(
      "PROJECT_PATH_SYMLINK_ESCAPE",
      "심볼릭 링크가 프로젝트 루트 밖을 가리킵니다.",
      { path: parentRelative },
    );
  }
  await lstat(actualParent);
  return {
    root,
    path: join(actualParent, safeRelativePath.split("/").at(-1)),
    relativePath: safeRelativePath,
  };
}

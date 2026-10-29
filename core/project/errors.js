export class ProjectError extends Error {
  constructor(code, message, details = {}, options = {}) {
    super(message, options);
    this.name = "ProjectError";
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}

export function asProjectError(error, fallbackCode = "PROJECT_IO_ERROR") {
  if (error instanceof ProjectError) return error;

  if (error?.code === "EACCES" || error?.code === "EPERM") {
    return new ProjectError(
      "PROJECT_PERMISSION_DENIED",
      "프로젝트 경로를 읽거나 쓸 권한이 없습니다.",
      {},
      { cause: error },
    );
  }

  return new ProjectError(
    fallbackCode,
    "프로젝트 파일 작업을 완료하지 못했습니다.",
    {},
    { cause: error },
  );
}

export function errorResponse(error) {
  return {
    ok: false,
    error: asProjectError(error).toJSON(),
  };
}

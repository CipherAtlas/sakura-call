import { readFile } from "node:fs/promises";
import { join, normalize, sep } from "node:path";
import { NextResponse } from "next/server";

const rnnoiseDistDirectory = join(
  process.cwd(),
  "node_modules",
  "@timephy",
  "rnnoise-wasm",
  "dist",
);

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{
    path?: string[];
  }>;
};

function resolveWorkletModulePath(pathSegments: string[] | undefined) {
  const requestedPath = (pathSegments ?? []).join("/");

  if (
    !requestedPath ||
    requestedPath.includes("\0") ||
    requestedPath.includes("..") ||
    requestedPath.startsWith("/")
  ) {
    return null;
  }

  const modulePath = requestedPath.endsWith(".js")
    ? requestedPath
    : `${requestedPath}.js`;
  const filePath = normalize(join(rnnoiseDistDirectory, modulePath));

  if (
    filePath !== rnnoiseDistDirectory &&
    !filePath.startsWith(`${rnnoiseDistDirectory}${sep}`)
  ) {
    return null;
  }

  return filePath;
}

export async function GET(_request: Request, context: RouteContext) {
  const { path } = await context.params;
  const filePath = resolveWorkletModulePath(path);

  if (!filePath) {
    return new NextResponse("Not found", { status: 404 });
  }

  try {
    const source = await readFile(filePath, "utf8");

    return new NextResponse(source, {
      headers: {
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Type": "text/javascript; charset=utf-8",
      },
    });
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}

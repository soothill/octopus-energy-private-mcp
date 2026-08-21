import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const packageMetadata = require("../package.json") as { version?: unknown };

if (typeof packageMetadata.version !== "string") {
  throw new Error("package.json does not contain a valid version");
}

export const CURRENT_VERSION = packageMetadata.version;

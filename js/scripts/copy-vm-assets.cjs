const { cpSync } = require("node:fs");
const { join } = require("node:path");
const root = join(__dirname, "..");
cpSync(
  join(root, "lib/resources/abstraction/vm-assets"),
  join(root, "dist/lib/resources/abstraction/vm-assets"),
  { recursive: true },
);

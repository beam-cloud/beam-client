import { FileSyncer } from "../lib/sync";
import { spawnSync } from "child_process";
import { join } from "path";

describe("FileSyncer - GitIgnore-Compliant Pattern Matching", () => {
  const ROOT_DIR = "/tmp/test-root";

  // Helper to test shouldIgnore by accessing private method
  const testShouldIgnore = (
    patterns: string[],
    filePath: string,
    isDirectory: boolean = false
  ): boolean => {
    const syncer = new FileSyncer(ROOT_DIR);
    (syncer as any).ignorePatterns = patterns;
    const absolutePath = join(ROOT_DIR, filePath);
    return (syncer as any).shouldIgnore(absolutePath, isDirectory);
  };

  // Helper to test shouldInclude
  const testShouldInclude = (
    patterns: string[],
    filePath: string,
    isDirectory: boolean = false
  ): boolean => {
    const syncer = new FileSyncer(ROOT_DIR);
    (syncer as any).includePatterns = patterns;
    const absolutePath = join(ROOT_DIR, filePath);
    return (syncer as any).shouldInclude(absolutePath, isDirectory);
  };

  describe("Basic wildcard patterns", () => {
    test("*.ext matches files with extension at any level", () => {
      // In gitignore, *.log matches at any level unless pattern has /
      expect(testShouldIgnore(["*.log"], "app.log")).toBe(true);
      expect(testShouldIgnore(["*.log"], "src/app.log")).toBe(true);
      expect(testShouldIgnore(["*.log"], "deep/nested/error.log")).toBe(true);
    });

    test("*.ext with different extensions", () => {
      expect(testShouldIgnore(["*.pyc"], "module.pyc")).toBe(true);
      expect(testShouldIgnore(["*.pyc"], "test.py")).toBe(false);
      expect(testShouldIgnore(["*.js"], "app.js")).toBe(true);
      expect(testShouldIgnore(["*.js"], "src/app.js")).toBe(true);
    });

    test("* pattern matches at any level", () => {
      // In gitignore, * pattern matches files at any level
      expect(testShouldIgnore(["*"], "file.txt")).toBe(true);
      expect(testShouldIgnore(["*"], "src/file.ts")).toBe(true);
    });

    test("wildcard in middle of pattern", () => {
      expect(testShouldIgnore(["test*.js"], "test-utils.js")).toBe(true);
      expect(testShouldIgnore(["test*.js"], "my-test-file.js")).toBe(false);
      expect(testShouldIgnore(["*test.js"], "my-test.js")).toBe(true);
    });
  });

  describe("Double asterisk ** patterns", () => {
    test("**/pattern matches at any depth", () => {
      expect(testShouldIgnore(["**/node_modules"], "node_modules")).toBe(true);
      expect(testShouldIgnore(["**/node_modules"], "src/node_modules")).toBe(true);
      expect(testShouldIgnore(["**/node_modules"], "deep/nested/node_modules")).toBe(true);
      expect(testShouldIgnore(["**/node_modules"], "node_modules_backup")).toBe(false);
    });

    test("**/directory/ matches directory at any depth", () => {
      expect(testShouldIgnore(["**/__pycache__/"], "__pycache__/module.pyc")).toBe(true);
      expect(testShouldIgnore(["**/__pycache__/"], "src/__pycache__/test.pyc")).toBe(true);
      expect(testShouldIgnore(["**/__pycache__/"], "__pycache__old/file.py")).toBe(false);
    });

    test("**/*.ext matches files at any depth", () => {
      expect(testShouldIgnore(["**/*.log"], "app.log")).toBe(true);
      expect(testShouldIgnore(["**/*.log"], "src/app.log")).toBe(true);
      expect(testShouldIgnore(["**/*.log"], "deep/nested/error.log")).toBe(true);
      expect(testShouldIgnore(["**/*.log"], "app.txt")).toBe(false);
    });

    test("pattern/** matches everything inside directory", () => {
      expect(testShouldIgnore(["dist/**"], "dist/bundle.js")).toBe(true);
      expect(testShouldIgnore(["dist/**"], "dist/nested/file.js")).toBe(true);
      expect(testShouldIgnore(["dist/**"], "src/dist/file.js")).toBe(false);
    });

    test("a/**/b matches with zero or more directories between", () => {
      expect(testShouldIgnore(["src/**/test.js"], "src/test.js")).toBe(true);
      expect(testShouldIgnore(["src/**/test.js"], "src/utils/test.js")).toBe(true);
      expect(testShouldIgnore(["src/**/test.js"], "src/deep/nested/test.js")).toBe(true);
      expect(testShouldIgnore(["src/**/test.js"], "lib/test.js")).toBe(false);
    });
  });

  describe("Directory vs file matching with trailing slash", () => {
    test("pattern/ only matches directories", () => {
      // build/ should match directory but not file named build
      expect(testShouldIgnore(["build/"], "build", true)).toBe(true); // directory
      expect(testShouldIgnore(["build/"], "build", false)).toBe(false); // file
    });

    test("directory patterns with trailing slash", () => {
      expect(testShouldIgnore(["node_modules/"], "node_modules", true)).toBe(true);
      expect(testShouldIgnore(["node_modules/"], "node_modules", false)).toBe(false);
      expect(testShouldIgnore([".venv/"], ".venv", true)).toBe(true);
      expect(testShouldIgnore([".venv/"], ".venv", false)).toBe(false);
    });

    test("pattern without trailing slash matches both", () => {
      expect(testShouldIgnore(["build"], "build", true)).toBe(true);
      expect(testShouldIgnore(["build"], "build", false)).toBe(true);
    });
  });

  describe("Negation patterns", () => {
    test("! negates previous ignore pattern", () => {
      const patterns = ["*.log", "!important.log"];
      expect(testShouldIgnore(patterns, "app.log")).toBe(true);
      expect(testShouldIgnore(patterns, "important.log")).toBe(false); // negated
      expect(testShouldIgnore(patterns, "error.log")).toBe(true);
    });

    test("negation pattern with directory", () => {
      const patterns = ["build/**", "!build/keep.txt"];
      expect(testShouldIgnore(patterns, "build/temp.txt")).toBe(true);
      expect(testShouldIgnore(patterns, "build/keep.txt")).toBe(false); // negated
    });

    test("cannot re-include if parent directory is excluded", () => {
      const patterns = ["node_modules/", "!node_modules/keep/"];
      // If parent is excluded, children cannot be re-included
      expect(testShouldIgnore(patterns, "node_modules", true)).toBe(true);
    });
  });

  describe("Root anchoring with leading slash", () => {
    test("/pattern only matches at root", () => {
      expect(testShouldIgnore(["/README.md"], "README.md")).toBe(true);
      expect(testShouldIgnore(["/README.md"], "docs/README.md")).toBe(false);
    });

    test("/dir/ matches directory only at root", () => {
      expect(testShouldIgnore(["/build/"], "build", true)).toBe(true);
      expect(testShouldIgnore(["/build/"], "src/build", true)).toBe(false);
    });

    test("pattern without / matches at any level", () => {
      expect(testShouldIgnore(["README.md"], "README.md")).toBe(true);
      expect(testShouldIgnore(["README.md"], "docs/README.md")).toBe(true);
    });
  });

  describe("Pattern with middle slash", () => {
    test("dir/file anchors to root", () => {
      expect(testShouldIgnore(["src/test.js"], "src/test.js")).toBe(true);
      expect(testShouldIgnore(["src/test.js"], "lib/src/test.js")).toBe(false);
    });

    test("dir/subdir/ matches specific path", () => {
      expect(testShouldIgnore(["src/tests/"], "src/tests", true)).toBe(true);
      expect(testShouldIgnore(["src/tests/"], "lib/src/tests", true)).toBe(false);
    });
  });

  describe("Character classes and special wildcards", () => {
    test("? matches single character", () => {
      expect(testShouldIgnore(["file?.txt"], "file1.txt")).toBe(true);
      expect(testShouldIgnore(["file?.txt"], "fileA.txt")).toBe(true);
      expect(testShouldIgnore(["file?.txt"], "file12.txt")).toBe(false);
      expect(testShouldIgnore(["file?.txt"], "file.txt")).toBe(false);
    });

    test("[...] character class matches character range", () => {
      expect(testShouldIgnore(["file[0-9].txt"], "file0.txt")).toBe(true);
      expect(testShouldIgnore(["file[0-9].txt"], "file5.txt")).toBe(true);
      expect(testShouldIgnore(["file[0-9].txt"], "fileA.txt")).toBe(false);
    });
  });

  describe("Escape sequences", () => {
    test("\\# matches literal hash", () => {
      expect(testShouldIgnore(["\\#file"], "#file")).toBe(true);
      expect(testShouldIgnore(["\\#file"], "file")).toBe(false);
    });

    test("\\* matches literal asterisk", () => {
      expect(testShouldIgnore(["file\\*.txt"], "file*.txt")).toBe(true);
      expect(testShouldIgnore(["file\\*.txt"], "file1.txt")).toBe(false);
    });
  });

  describe("Multiple patterns", () => {
    test("applies all patterns in order", () => {
      const patterns = ["*.log", "dist/**", "**/node_modules/"];
      expect(testShouldIgnore(patterns, "app.log")).toBe(true);
      expect(testShouldIgnore(patterns, "dist/bundle.js")).toBe(true);
      expect(testShouldIgnore(patterns, "src/node_modules/pkg")).toBe(true);
      expect(testShouldIgnore(patterns, "src/index.ts")).toBe(false);
    });

    test("later negation overrides earlier ignore", () => {
      const patterns = ["*.log", "!important.log", "!debug.log"];
      expect(testShouldIgnore(patterns, "app.log")).toBe(true);
      expect(testShouldIgnore(patterns, "important.log")).toBe(false);
      expect(testShouldIgnore(patterns, "debug.log")).toBe(false);
    });
  });

  describe("Edge cases", () => {
    test("empty patterns array ignores nothing", () => {
      expect(testShouldIgnore([], "file.txt")).toBe(false);
      expect(testShouldIgnore([], "src/index.ts")).toBe(false);
    });

    test("handles paths with special characters", () => {
      expect(testShouldIgnore(["*.test.ts"], "app.test.ts")).toBe(true);
      expect(testShouldIgnore(["file-name.txt"], "file-name.txt")).toBe(true);
      expect(testShouldIgnore(["my_file.py"], "my_file.py")).toBe(true);
    });

    test("handles deeply nested paths", () => {
      expect(
        testShouldIgnore(
          ["**/temp/**"],
          "very/deeply/nested/path/to/temp/file.txt"
        )
      ).toBe(true);
    });

    test("case insensitive matching by default", () => {
      // node-ignore is case-insensitive by default
      expect(testShouldIgnore(["README.md"], "readme.md")).toBe(true);
      expect(testShouldIgnore(["src/"], "SRC", true)).toBe(true);
    });
  });

  describe("Common real-world ignore patterns", () => {
    const commonPatterns = [
      ".git",
      ".vscode",
      "node_modules",
      "**/__pycache__/",
      "**/.pytest_cache/",
      "*.pyc",
      ".DS_Store",
      "dist/**",
      "build/**",
    ];

    test("ignores version control directories", () => {
      expect(testShouldIgnore(commonPatterns, ".git")).toBe(true);
      expect(testShouldIgnore(commonPatterns, ".vscode")).toBe(true);
    });

    test("ignores dependency directories", () => {
      expect(testShouldIgnore(commonPatterns, "node_modules")).toBe(true);
    });

    test("ignores Python artifacts", () => {
      expect(testShouldIgnore(commonPatterns, "src/__pycache__/module.pyc")).toBe(true);
      expect(testShouldIgnore(commonPatterns, "test.pyc")).toBe(true);
      expect(testShouldIgnore(commonPatterns, "tests/.pytest_cache/results.xml")).toBe(true);
    });

    test("ignores build outputs", () => {
      expect(testShouldIgnore(commonPatterns, "dist/bundle.js")).toBe(true);
      expect(testShouldIgnore(commonPatterns, "build/output.js")).toBe(true);
    });

    test("allows source files", () => {
      expect(testShouldIgnore(commonPatterns, "src/index.ts")).toBe(false);
      expect(testShouldIgnore(commonPatterns, "lib/util.js")).toBe(false);
      expect(testShouldIgnore(commonPatterns, "README.md")).toBe(false);
    });
  });

  describe("Include patterns", () => {
    test("empty include patterns includes everything", () => {
      expect(testShouldInclude([], "file.txt")).toBe(true);
      expect(testShouldInclude([], "src/index.ts")).toBe(true);
    });

    test("include specific files", () => {
      expect(testShouldInclude(["src/index.ts"], "src/index.ts")).toBe(true);
      expect(testShouldInclude(["src/index.ts"], "src/other.ts")).toBe(false);
    });

    test("include with wildcards", () => {
      expect(testShouldInclude(["*.ts"], "app.ts")).toBe(true);
      expect(testShouldInclude(["*.ts"], "app.js")).toBe(false);
    });

    test("include directory contents", () => {
      expect(testShouldInclude(["src"], "src/index.ts")).toBe(true);
      expect(testShouldInclude(["src"], "lib/util.js")).toBe(false);
    });

    test("include with ** patterns", () => {
      expect(testShouldInclude(["src/**"], "src/index.ts")).toBe(true);
      expect(testShouldInclude(["src/**"], "src/deep/nested/file.ts")).toBe(true);
      expect(testShouldInclude(["src/**"], "lib/index.ts")).toBe(false);
    });
  });

  describe("Ignore and include interaction", () => {
    test("both ignore and include work together", () => {
      const syncer = new FileSyncer(ROOT_DIR);
      (syncer as any).ignorePatterns = ["*.log", "dist/**"];
      (syncer as any).includePatterns = ["src"];

      const shouldIgnore = (path: string) => {
        const absolutePath = join(ROOT_DIR, path);
        return (syncer as any).shouldIgnore(absolutePath, false);
      };
      const shouldInclude = (path: string) => {
        const absolutePath = join(ROOT_DIR, path);
        return (syncer as any).shouldInclude(absolutePath, false);
      };

      // File in src, not ignored, should be included
      expect(shouldInclude("src/index.ts")).toBe(true);
      expect(shouldIgnore("src/index.ts")).toBe(false);

      // Log file should be ignored even if in src
      expect(shouldIgnore("src/app.log")).toBe(true);
      expect(shouldInclude("src/app.log")).toBe(true);

      // File in dist should be ignored
      expect(shouldIgnore("dist/bundle.js")).toBe(true);

      // File outside src
      expect(shouldInclude("lib/util.ts")).toBe(false);
    });
  });
});

describe("FileSyncer - ZIP timestamp normalization", () => {
  const getDosTimestampForTimezone = (dateInput: string, timezone: string): number => {
    const script = `
      function dateToDos(d) {
        var year = d.getFullYear();
        if (year < 1980) return 2162688;
        if (year >= 2044) return 2141175677;
        return ((year - 1980) << 25) | ((d.getMonth() + 1) << 21) | (d.getDate() << 16) |
          (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() / 2);
      }
      const date = new Date(process.argv[1]);
      process.stdout.write(String(dateToDos(date)));
    `;

    const result = spawnSync(process.execPath, ["-e", script, dateInput], {
      env: { ...process.env, TZ: timezone },
      encoding: "utf8",
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).not.toBe("");

    return Number.parseInt(result.stdout.trim(), 10);
  };

  test("uses a timezone-stable local-midnight date string", () => {
    const dosTimestamps = ["UTC", "America/Los_Angeles", "Asia/Tokyo"].map((timezone) =>
      getDosTimestampForTimezone("1980-01-01T00:00:00", timezone)
    );

    expect(new Set(dosTimestamps).size).toBe(1);
  });

  test("would drift if switched to an explicit UTC timestamp string", () => {
    const utcTimestamp = getDosTimestampForTimezone("1980-01-01T00:00:00Z", "UTC");
    const tokyoTimestamp = getDosTimestampForTimezone(
      "1980-01-01T00:00:00Z",
      "Asia/Tokyo"
    );

    expect(tokyoTimestamp).not.toBe(utcTimestamp);
  });
});

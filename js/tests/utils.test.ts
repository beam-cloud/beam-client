import {
  snakeCaseToCamelCaseKeys,
  camelCaseToSnakeCaseKeys,
  formatBytes,
  parseMemory,
  parseCpu,
  parseGpu,
  formatEnv,
  schemaToApi,
} from "../lib/util";
import { Schema } from "../lib/types/schema";
import {
  GpuType,
  PythonVersion,
  PythonVersionAlias,
} from "../lib/types/common";

describe("snakeCaseToCamelCaseKeys", () => {
  test("converts simple snake_case keys to camelCase", () => {
    const input = { snake_case_key: "value", another_key: "value2" };
    const expected = { snakeCaseKey: "value", anotherKey: "value2" };
    expect(snakeCaseToCamelCaseKeys(input)).toEqual(expected);
  });

  test("handles single underscore", () => {
    const input = { simple_key: "value" };
    const expected = { simpleKey: "value" };
    expect(snakeCaseToCamelCaseKeys(input)).toEqual(expected);
  });

  test("handles multiple underscores", () => {
    const input = { very_long_snake_case_key: "value" };
    const expected = { veryLongSnakeCaseKey: "value" };
    expect(snakeCaseToCamelCaseKeys(input)).toEqual(expected);
  });

  test("leaves keys without underscores unchanged", () => {
    const input = { normalkey: "value", anotherkey: "value2" };
    const expected = { normalkey: "value", anotherkey: "value2" };
    expect(snakeCaseToCamelCaseKeys(input)).toEqual(expected);
  });

  test("handles empty object", () => {
    expect(snakeCaseToCamelCaseKeys({})).toEqual({});
  });

  test("handles mixed key types", () => {
    const input = {
      snake_case: "value",
      normalkey: "value2",
      another_snake: "value3",
    };
    const expected = {
      snakeCase: "value",
      normalkey: "value2",
      anotherSnake: "value3",
    };
    expect(snakeCaseToCamelCaseKeys(input)).toEqual(expected);
  });

  test("preserves values unchanged", () => {
    const input = { snake_key: { nested: "object" }, another_key: [1, 2, 3] };
    const expected = { snakeKey: { nested: "object" }, anotherKey: [1, 2, 3] };
    expect(snakeCaseToCamelCaseKeys(input)).toEqual(expected);
  });

  test("handles nested objects", () => {
    const input = { snake_key: { nested: "object" }, another_key: [1, 2, 3] };
    const expected = { snakeKey: { nested: "object" }, anotherKey: [1, 2, 3] };
    expect(snakeCaseToCamelCaseKeys(input)).toEqual(expected);
  });

  test("handles nested object with snake_case keys", () => {
    const input = {
      snake_key: { nested_key: "object" },
      another_key: [1, 2, 3],
    };
    const expected = {
      snakeKey: { nestedKey: "object" },
      anotherKey: [1, 2, 3],
    };
    expect(snakeCaseToCamelCaseKeys(input)).toEqual(expected);
  });

  test("handles nested object is an array of objects", () => {
    const input = {
      snake_key: [{ nested_key: "object" }, { nested_key2: "object2" }],
    };
    const expected = {
      snakeKey: [{ nestedKey: "object" }, { nestedKey2: "object2" }],
    };
    expect(snakeCaseToCamelCaseKeys(input)).toEqual(expected);
  });

  test("handle object is an array of strings", () => {
    const input = { snake_key: ["object", "object2"] };
    const expected = { snakeKey: ["object", "object2"] };
    expect(snakeCaseToCamelCaseKeys(input)).toEqual(expected);
  });

  test("handle object is an array of numbers", () => {
    const input = { snake_key: [1, 2, 3] };
    const expected = { snakeKey: [1, 2, 3] };
    expect(snakeCaseToCamelCaseKeys(input)).toEqual(expected);
  });

  test("handle object is an array of booleans", () => {
    const input = { snake_key: [true, false] };
    const expected = { snakeKey: [true, false] };
    expect(snakeCaseToCamelCaseKeys(input)).toEqual(expected);
  });

  test("handle object is an array of null", () => {
    const input = { snake_key: [null, null] };
    const expected = { snakeKey: [null, null] };
    expect(snakeCaseToCamelCaseKeys(input)).toEqual(expected);
  });

  test("handle object is an array of undefined", () => {
    const input = { snake_key: [undefined, undefined] };
    const expected = { snakeKey: [undefined, undefined] };
    expect(snakeCaseToCamelCaseKeys(input)).toEqual(expected);
  });
});

describe("camelCaseToSnakeCaseKeys", () => {
  test("converts simple camelCase keys to snake_case", () => {
    const input = { camelCaseKey: "value", anotherKey: "value2" };
    const expected = { camel_case_key: "value", another_key: "value2" };
    expect(camelCaseToSnakeCaseKeys(input)).toEqual(expected);
  });

  test("handles single uppercase letter", () => {
    const input = { simpleKey: "value" };
    const expected = { simple_key: "value" };
    expect(camelCaseToSnakeCaseKeys(input)).toEqual(expected);
  });

  test("handles multiple uppercase letters", () => {
    const input = { veryLongCamelCaseKey: "value" };
    const expected = { very_long_camel_case_key: "value" };
    expect(camelCaseToSnakeCaseKeys(input)).toEqual(expected);
  });

  test("leaves lowercase keys unchanged", () => {
    const input = { normalkey: "value", anotherkey: "value2" };
    const expected = { normalkey: "value", anotherkey: "value2" };
    expect(camelCaseToSnakeCaseKeys(input)).toEqual(expected);
  });

  test("handles empty object", () => {
    expect(camelCaseToSnakeCaseKeys({})).toEqual({});
  });

  test("handles mixed key types", () => {
    const input = {
      camelCase: "value",
      normalkey: "value2",
      anotherCamel: "value3",
    };
    const expected = {
      camel_case: "value",
      normalkey: "value2",
      another_camel: "value3",
    };
    expect(camelCaseToSnakeCaseKeys(input)).toEqual(expected);
  });

  test("preserves values unchanged", () => {
    const input = { camelKey: { nested: "object" }, anotherKey: [1, 2, 3] };
    const expected = {
      camel_key: { nested: "object" },
      another_key: [1, 2, 3],
    };
    expect(camelCaseToSnakeCaseKeys(input)).toEqual(expected);
  });

  test("handles nested object with snake_case keys", () => {
    const input = { camelKey: { nested_key: "object" }, anotherKey: [1, 2, 3] };
    const expected = {
      camel_key: { nested_key: "object" },
      another_key: [1, 2, 3],
    };
    expect(camelCaseToSnakeCaseKeys(input)).toEqual(expected);
  });

  test("handles nested object with camelCase keys", () => {
    const input = { camelKey: { nestedKey: "object" }, anotherKey: [1, 2, 3] };
    const expected = {
      camel_key: { nested_key: "object" },
      another_key: [1, 2, 3],
    };
    expect(camelCaseToSnakeCaseKeys(input)).toEqual(expected);

    const input2 = { camelKey: { nestedKey: "object" }, anotherKey: [1, 2, 3] };
    const expected2 = {
      camel_key: { nested_key: "object" },
      another_key: [1, 2, 3],
    };
    expect(camelCaseToSnakeCaseKeys(input2)).toEqual(expected2);
  });

  test("handles nested object is an array of objects", () => {
    const input = {
      camelKey: [{ nestedKey: "object" }, { nestedKey2: "object2" }],
    };
    const expected = {
      camel_key: [{ nested_key: "object" }, { nested_key2: "object2" }],
    };
    expect(camelCaseToSnakeCaseKeys(input)).toEqual(expected);
  });

  test("handle object is an array of strings", () => {
    const input = { camelKey: ["object", "object2"] };
    const expected = { camel_key: ["object", "object2"] };
    expect(camelCaseToSnakeCaseKeys(input)).toEqual(expected);
  });

  test("handle object is an array of numbers", () => {
    const input = { camelKey: [1, 2, 3] };
    const expected = { camel_key: [1, 2, 3] };
    expect(camelCaseToSnakeCaseKeys(input)).toEqual(expected);
  });

  test("handle object is an array of booleans", () => {
    const input = { camelKey: [true, false] };
    const expected = { camel_key: [true, false] };
    expect(camelCaseToSnakeCaseKeys(input)).toEqual(expected);
  });

  test("handle object is an array of null", () => {
    const input = { camelKey: [null, null] };
    const expected = { camel_key: [null, null] };
    expect(camelCaseToSnakeCaseKeys(input)).toEqual(expected);
  });

  test("handle object is an array of undefined", () => {
    const input = { camelKey: [undefined, undefined] };
    const expected = { camel_key: [undefined, undefined] };
    expect(camelCaseToSnakeCaseKeys(input)).toEqual(expected);
  });
});

describe("formatBytes", () => {
  test("formats 0 bytes", () => {
    expect(formatBytes(0)).toBe("0 Bytes");
  });

  test("formats bytes", () => {
    expect(formatBytes(512)).toBe("512 Bytes");
    expect(formatBytes(1023)).toBe("1023 Bytes");
  });

  test("formats kilobytes", () => {
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(2048)).toBe("2 KB");
  });

  test("formats megabytes", () => {
    expect(formatBytes(1024 * 1024)).toBe("1 MB");
    expect(formatBytes(1024 * 1024 * 1.5)).toBe("1.5 MB");
    expect(formatBytes(1024 * 1024 * 2.5)).toBe("2.5 MB");
  });

  test("formats gigabytes", () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1 GB");
    expect(formatBytes(1024 * 1024 * 1024 * 2.5)).toBe("2.5 GB");
  });

  test("rounds to 2 decimal places", () => {
    expect(formatBytes(1234567)).toBe("1.18 MB");
    expect(formatBytes(1234567890)).toBe("1.15 GB");
  });

  test("handles large numbers", () => {
    expect(() => formatBytes(1024 * 1024 * 1024 * 1024)).toThrow(
      "We don't support terabytes in memory"
    );
  });
});

describe("parseMemory", () => {
  test("returns number as-is", () => {
    expect(parseMemory(1024)).toBe(1024);
    expect(parseMemory(0)).toBe(0);
    expect(parseMemory(2048)).toBe(2048);
  });

  test("parses Mi suffix", () => {
    expect(parseMemory("512Mi")).toBe(512);
    expect(parseMemory("1024Mi")).toBe(1024);
    expect(parseMemory("0Mi")).toBe(0);
  });

  test("parses mi suffix (case insensitive)", () => {
    expect(parseMemory("512mi")).toBe(512);
    expect(parseMemory("1024mi")).toBe(1024);
  });

  test("parses Gb suffix", () => {
    expect(parseMemory("1Gb")).toBe(1000);
    expect(parseMemory("2Gb")).toBe(2000);
    expect(parseMemory("0Gb")).toBe(0);
  });

  test("parses gb suffix (case insensitive)", () => {
    expect(parseMemory("1gb")).toBe(1000);
    expect(parseMemory("2gb")).toBe(2000);
  });

  test("parses Gi suffix", () => {
    expect(parseMemory("1Gi")).toBe(1024);
    expect(parseMemory("2Gi")).toBe(2048);
    expect(parseMemory("0Gi")).toBe(0);
  });

  test("parses gi suffix (case insensitive)", () => {
    expect(parseMemory("1gi")).toBe(1024);
    expect(parseMemory("2gi")).toBe(2048);
  });

  test("throws error for unsupported string format", () => {
    expect(() => parseMemory("1TB")).toThrow("Unsupported memory format");
    expect(() => parseMemory("1000KB")).toThrow("Unsupported memory format");
    expect(() => parseMemory("invalid")).toThrow("Unsupported memory format");
  });

  test("throws error for non-string, non-number input", () => {
    expect(() => parseMemory(null as any)).toThrow(
      "Memory must be a number or string"
    );
    expect(() => parseMemory(undefined as any)).toThrow(
      "Memory must be a number or string"
    );
    expect(() => parseMemory({} as any)).toThrow(
      "Memory must be a number or string"
    );
  });
});

describe("parseCpu", () => {
  test("converts valid number to millicores", () => {
    expect(parseCpu(1)).toBe(1000);
    expect(parseCpu(0.5)).toBe(500);
    expect(parseCpu(2.5)).toBe(2500);
    expect(parseCpu(0.1)).toBe(100);
    expect(parseCpu(64)).toBe(64000);
  });

  test("throws error for number out of range", () => {
    expect(() => parseCpu(0.05)).toThrow(
      "CPU value out of range. Must be between 0.1 and 64 cores."
    );
    expect(() => parseCpu(65)).toThrow(
      "CPU value out of range. Must be between 0.1 and 64 cores."
    );
    expect(() => parseCpu(0)).toThrow(
      "CPU value out of range. Must be between 0.1 and 64 cores."
    );
    expect(() => parseCpu(-1)).toThrow(
      "CPU value out of range. Must be between 0.1 and 64 cores."
    );
  });

  test("parses valid millicores string", () => {
    expect(parseCpu("1000m")).toBe(1000);
    expect(parseCpu("500m")).toBe(500);
    expect(parseCpu("100m")).toBe(100);
    expect(parseCpu("64000m")).toBe(64000);
  });

  test("throws error for millicores out of range", () => {
    expect(() => parseCpu("50m")).toThrow(
      "CPU value out of range. Must be between 100m and 64000m."
    );
    expect(() => parseCpu("65000m")).toThrow(
      "CPU value out of range. Must be between 100m and 64000m."
    );
    expect(() => parseCpu("0m")).toThrow(
      "CPU value out of range. Must be between 100m and 64000m."
    );
  });

  test("throws error for invalid string format", () => {
    expect(() => parseCpu("1000")).toThrow(
      "Invalid CPU string format. Must be a digit followed by 'm' (e.g., '1000m')."
    );
    expect(() => parseCpu("1.5m")).toThrow(
      "Invalid CPU string format. Must be a digit followed by 'm' (e.g., '1000m')."
    );
    expect(() => parseCpu("abcm")).toThrow(
      "Invalid CPU string format. Must be a digit followed by 'm' (e.g., '1000m')."
    );
    expect(() => parseCpu("1000x")).toThrow(
      "Invalid CPU string format. Must be a digit followed by 'm' (e.g., '1000m')."
    );
    expect(() => parseCpu("")).toThrow(
      "Invalid CPU string format. Must be a digit followed by 'm' (e.g., '1000m')."
    );
  });

  test("throws error for invalid input type", () => {
    expect(() => parseCpu(null as any)).toThrow(
      "CPU must be a number or string."
    );
    expect(() => parseCpu(undefined as any)).toThrow(
      "CPU must be a number or string."
    );
    expect(() => parseCpu({} as any)).toThrow(
      "CPU must be a number or string."
    );
    expect(() => parseCpu([] as any)).toThrow(
      "CPU must be a number or string."
    );
  });
});

describe("parseGpu", () => {
  test("joins array of GPUs with comma", () => {
    expect(parseGpu([GpuType.T4, GpuType.L4])).toBe("T4,L4");
    expect(parseGpu([GpuType.A100_40, GpuType.H100])).toBe("A100-40,H100");
    expect(parseGpu([GpuType.Any])).toBe("any");
  });

  test("returns single GPU as string", () => {
    expect(parseGpu(GpuType.T4)).toBe("T4");
    expect(parseGpu(GpuType.A100_80)).toBe("A100-80");
    expect(parseGpu(GpuType.NoGPU)).toBe("");
    expect(parseGpu(GpuType.Any)).toBe("any");
  });

  test("handles empty array", () => {
    expect(parseGpu([])).toBe("");
  });

  test("handles mixed array types", () => {
    expect(parseGpu([GpuType.T4, GpuType.L4, GpuType.A100_40])).toBe(
      "T4,L4,A100-40"
    );
  });

  test("handles string literal GPU types", () => {
    expect(parseGpu("H100")).toBe("H100");
    expect(parseGpu("T4")).toBe("T4");
    expect(parseGpu("A100-40")).toBe("A100-40");
    expect(parseGpu("")).toBe("");
    expect(parseGpu("any")).toBe("any");
  });

  test("handles array of string literal GPU types", () => {
    expect(parseGpu(["T4", "L4"])).toBe("T4,L4");
    expect(parseGpu(["H100", "A100-40"])).toBe("H100,A100-40");
    expect(parseGpu(["any"])).toBe("any");
  });

  test("handles mixed enum and string literal arrays", () => {
    expect(parseGpu(["H100", GpuType.A100_40])).toBe("H100,A100-40");
    expect(parseGpu([GpuType.T4, "L4", GpuType.A100_40])).toBe("T4,L4,A100-40");
  });
});

describe("PythonVersionAlias", () => {
  test("accepts PythonVersion enum values", () => {
    const testFunction = (version: PythonVersionAlias): string => {
      return version.toString();
    };

    expect(testFunction(PythonVersion.Python311)).toBe("python3.11");
    expect(testFunction(PythonVersion.Python310)).toBe("python3.10");
    expect(testFunction(PythonVersion.Python39)).toBe("python3.9");
    expect(testFunction(PythonVersion.Python312)).toBe("python3.12");
  });

  test("accepts string literal values", () => {
    const testFunction = (version: PythonVersionAlias): string => {
      return version.toString();
    };

    expect(testFunction("python3.11")).toBe("python3.11");
    expect(testFunction("python3.10")).toBe("python3.10");
    expect(testFunction("python3.9")).toBe("python3.9");
    expect(testFunction("micromamba3.11")).toBe("micromamba3.11");
  });

  test("accepts mixed usage in arrays", () => {
    const versions: PythonVersionAlias[] = [
      PythonVersion.Python311,
      "python3.10",
      PythonVersion.Python39,
      "micromamba3.11",
    ];

    expect(versions[0]).toBe("python3.11");
    expect(versions[1]).toBe("python3.10");
    expect(versions[2]).toBe("python3.9");
    expect(versions[3]).toBe("micromamba3.11");
  });
});

describe("formatEnv", () => {
  test("returns array as-is", () => {
    const input = ["VAR1=value1", "VAR2=value2"];
    expect(formatEnv(input)).toEqual(input);
  });

  test("converts object to key=value array", () => {
    const input = { VAR1: "value1", VAR2: "value2" };
    const result = formatEnv(input);
    expect(result).toHaveLength(2);
    expect(result).toContain("VAR1=value1");
    expect(result).toContain("VAR2=value2");
  });

  test("handles empty array", () => {
    expect(formatEnv([])).toEqual([]);
  });

  test("handles empty object", () => {
    expect(formatEnv({})).toEqual([]);
  });

  test("handles object with special characters in values", () => {
    const input = {
      PATH: "/usr/bin:/bin",
      MESSAGE: "hello world", // TODO: this is not a valid environment variable, needs quoting or escaping
      SPECIAL: "value=with=equals", // TODO: this is not a valid environment variable
    };
    const result = formatEnv(input);
    expect(result).toContain("PATH=/usr/bin:/bin");
    expect(result).toContain("MESSAGE=hello world");
    expect(result).toContain("SPECIAL=value=with=equals");
  });

  test("handles numeric and boolean values", () => {
    const input = {
      PORT: "3000",
      DEBUG: "true",
      COUNT: "42",
    };
    const result = formatEnv(input);
    expect(result).toContain("PORT=3000");
    expect(result).toContain("DEBUG=true");
    expect(result).toContain("COUNT=42");
  });
});

describe("schemaToApi", () => {
  test("returns undefined for undefined schema", () => {
    expect(schemaToApi(undefined)).toBeUndefined();
  });

  test("converts simple schema with basic fields", () => {
    const schema = new Schema({
      fields: {
        name: { type: "string" },
        age: { type: "number" },
      },
    });

    const result = schemaToApi(schema);
    expect(result).toEqual({
      fields: {
        name: { type: "string" },
        age: { type: "number" },
      },
    });
  });

  test("converts schema with Object type and nested fields", () => {
    const schema = new Schema({
      fields: {
        user: {
          type: "Object",
          fields: {
            name: { type: "string" },
            email: { type: "string" },
          },
        },
      },
    });

    const result = schemaToApi(schema);
    expect(result).toEqual({
      fields: {
        user: {
          type: "object",
          fields: {
            fields: {
              name: { type: "string" },
              email: { type: "string" },
            },
          },
        },
      },
    });
  });

  test("converts mixed schema with Object and simple fields", () => {
    const schema = new Schema({
      fields: {
        id: { type: "string" },
        metadata: {
          type: "Object",
          fields: {
            created: { type: "string" },
            updated: { type: "string" },
          },
        },
        count: { type: "number" },
      },
    });

    const result = schemaToApi(schema);
    expect(result).toEqual({
      fields: {
        id: { type: "string" },
        metadata: {
          type: "object",
          fields: {
            fields: {
              created: { type: "string" },
              updated: { type: "string" },
            },
          },
        },
        count: { type: "number" },
      },
    });
  });

  test("handles deeply nested Object fields", () => {
    const schema = new Schema({
      fields: {
        config: {
          type: "Object",
          fields: {
            database: {
              type: "Object",
              fields: {
                host: { type: "string" },
                port: { type: "number" },
              },
            },
          },
        },
      },
    });

    const result = schemaToApi(schema);
    expect(result).toEqual({
      fields: {
        config: {
          type: "object",
          fields: {
            fields: {
              database: {
                type: "object",
                fields: {
                  fields: {
                    host: { type: "string" },
                    port: { type: "number" },
                  },
                },
              },
            },
          },
        },
      },
    });
  });

  test("handles empty schema", () => {
    const schema = new Schema({ fields: {} });
    const result = schemaToApi(schema);
    expect(result).toEqual({ fields: {} });
  });
});

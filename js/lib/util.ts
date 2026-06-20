import { Schema } from "lib";
import { GpuTypeAlias } from "./types/common";
import { createReadStream, statSync } from "fs";
import axios from "axios";

export const snakeCaseToCamelCaseKeys = (obj: any): any => {
  if (Array.isArray(obj)) {
    return obj.map((o) => {
      if (typeof o === "object" && o !== null) {
        return snakeCaseToCamelCaseKeys(o);
      }
      return o;
    });
  }

  const newObj: any = {};
  Object.keys(obj).forEach((key) => {
    const initialKey = String(key);
    const currentObject = obj[initialKey];
    if (typeof currentObject === "object" && currentObject !== null) {
      newObj[key.replace(/_([a-z])/g, (g) => g[1].toUpperCase())] =
        snakeCaseToCamelCaseKeys(currentObject);
    } else {
      newObj[key.replace(/_([a-z])/g, (g) => g[1].toUpperCase())] =
        currentObject;
    }
  });
  return newObj;
};

export const camelCaseToSnakeCaseKeys = (obj: any): any => {
  if (Array.isArray(obj)) {
    return obj.map((o) => {
      if (typeof o === "object" && o !== null) {
        return camelCaseToSnakeCaseKeys(o);
      }
      return o;
    });
  }

  const newObj: any = {};
  Object.keys(obj).forEach((key) => {
    const initialKey = String(key);
    const currentObject = obj[initialKey];
    if (typeof currentObject === "object" && currentObject !== null) {
      newObj[key.replace(/[A-Z]/g, (g) => `_${g.toLowerCase()}`)] =
        camelCaseToSnakeCaseKeys(currentObject);
    } else {
      newObj[key.replace(/[A-Z]/g, (g) => `_${g.toLowerCase()}`)] =
        currentObject;
    }
  });
  return newObj;
};

export const formatBytes = (bytes: number): string => {
  // We don't support terabytes in memory
  if (bytes >= 1024 * 1024 * 1024 * 1024) {
    throw new Error("We don't support terabytes in memory");
  }

  const sizes = ["Bytes", "KB", "MB", "GB"];
  if (bytes === 0) return "0 Bytes";
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return Math.round((bytes / Math.pow(1024, i)) * 100) / 100 + " " + sizes[i];
};

export const parseMemory = (memory: string | number): number => {
  if (typeof memory === "number") {
    return memory;
  }

  if (typeof memory === "string") {
    if (memory.toLowerCase().endsWith("mi")) {
      return parseInt(memory.slice(0, -2));
    } else if (memory.toLowerCase().endsWith("gb")) {
      return parseInt(memory.slice(0, -2)) * 1000;
    } else if (memory.toLowerCase().endsWith("gi")) {
      return parseInt(memory.slice(0, -2)) * 1024;
    } else {
      throw new Error("Unsupported memory format");
    }
  }

  throw new Error("Memory must be a number or string");
};

export const parseCpu = (cpu: number | string): number => {
  const minCores = 0.1;
  const maxCores = 64.0;

  if (typeof cpu === "number") {
    if (cpu >= minCores && cpu <= maxCores) {
      return Math.floor(cpu * 1000); // convert cores to millicores
    } else {
      throw new Error(
        "CPU value out of range. Must be between 0.1 and 64 cores."
      );
    }
  }

  if (typeof cpu === "string") {
    if (cpu.endsWith("m") && /^\d+$/.test(cpu.slice(0, -1))) {
      const millicores = parseInt(cpu.slice(0, -1));
      if (millicores >= minCores * 1000 && millicores <= maxCores * 1000) {
        return millicores;
      } else {
        throw new Error(
          "CPU value out of range. Must be between 100m and 64000m."
        );
      }
    } else {
      throw new Error(
        "Invalid CPU string format. Must be a digit followed by 'm' (e.g., '1000m')."
      );
    }
  }

  throw new Error("CPU must be a number or string.");
};

export const parseGpu = (gpu: GpuTypeAlias | GpuTypeAlias[]): string => {
  if (Array.isArray(gpu)) {
    return gpu.join(",");
  }
  return gpu;
};

export const formatEnv = (env: Record<string, string> | string[]): string[] => {
  if (Array.isArray(env)) {
    return env;
  }

  return Object.entries(env).map(([k, v]) => `${k}=${v}`);
};

export const schemaToApi = (pySchema?: Schema): any => {
  if (!pySchema) {
    return undefined;
  }

  const fieldToApi = (field: any): any => {
    if (field.type === "Object" && field.fields) {
      return {
        type: "object",
        fields: {
          fields: Object.fromEntries(
            Object.entries(field.fields.fields).map(([k, v]) => [
              k,
              fieldToApi(v),
            ])
          ),
        },
      };
    }
    return { type: field.type };
  };

  const fieldsDict = pySchema.toDict().fields;
  return {
    fields: Object.fromEntries(
      Object.entries(fieldsDict).map(([k, v]) => [k, fieldToApi(v)])
    ),
  };
};

export const uploadToPresignedUrl = async (
  presignedUrl: string,
  filePath: string
): Promise<boolean> => {
  try {
    const stats = statSync(filePath);
    const fileStream = createReadStream(filePath);

    console.log(`Uploading ${formatBytes(stats.size)} to cloud storage...`);

    await axios.put(presignedUrl, fileStream, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Length": stats.size.toString(),
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 300000, // 5 minute timeout for large files
      onUploadProgress: (progressEvent) => {
        if (progressEvent.total) {
          const progress = (
            (progressEvent.loaded / progressEvent.total) *
            100
          ).toFixed(1);
          console.log(
            `Upload progress: ${progress}% (${formatBytes(
              progressEvent.loaded
            )}/${formatBytes(progressEvent.total)})`
          );
        }
      },
    });

    console.log("Upload completed successfully ✅");
    return true;
  } catch (error) {
    console.error("Upload failed:", error);
    return false;
  }
};

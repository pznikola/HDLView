import type { Profile } from "./types";

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function isProfile(value: unknown): value is Profile {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  return (
    "provider" in value &&
    (value.provider === "native" || value.provider === "docker") &&
    (!("executables" in value) || isStringRecord(value.executables)) &&
    (!("plugins" in value) || isStringRecord(value.plugins)) &&
    (!("env" in value) || isStringRecord(value.env)) &&
    (!("timeout_seconds" in value) ||
      (typeof value.timeout_seconds === "number" &&
        Number.isSafeInteger(value.timeout_seconds) &&
        value.timeout_seconds >= 0)) &&
    (!("image" in value) ||
      value.image === null ||
      typeof value.image === "string") &&
    (!("pdk_root" in value) ||
      value.pdk_root === null ||
      typeof value.pdk_root === "string")
  );
}

export function parseProfile(text: string): Profile {
  const value: unknown = JSON.parse(text);
  if (!isProfile(value)) {
    throw new Error(
      "Invalid toolchain profile: expected a native/Docker provider, string maps for executables/plugins/env, and a nonnegative integer timeout when supplied.",
    );
  }
  return value;
}

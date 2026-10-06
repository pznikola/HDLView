import { describe, expect, it } from "vitest";
import { parseProfile } from "./profile";

describe("toolchain profile input", () => {
  it("preserves native profiles with backend-defaulted fields", () => {
    const profile = { provider: "native", env: { PATH: "/tools/bin" } };
    expect(parseProfile(JSON.stringify(profile))).toEqual(profile);
  });

  it("accepts Docker settings and nullable paths from backend serialization", () => {
    const profile = {
      provider: "docker",
      image: "hdlview-tools:2025.12",
      pdk_root: null,
      executables: { librelane: "/usr/local/bin/librelane" },
      plugins: {},
      env: {},
      timeout_seconds: 3600,
    };
    expect(parseProfile(JSON.stringify(profile))).toEqual(profile);
    expect(parseProfile('{"provider":"native","image":null}').image).toBeNull();
  });

  it.each([
    null,
    [],
    {},
    { provider: "remote" },
    { provider: "native", env: { PATH: 42 } },
    { provider: "native", plugins: [] },
    { provider: "native", executables: null },
    { provider: "native", timeout_seconds: -1 },
    { provider: "native", timeout_seconds: 0.5 },
    { provider: "native", timeout_seconds: "600" },
    { provider: "docker", image: 123 },
    { provider: "native", pdk_root: [] },
  ])("rejects malformed profile %j", (value) => {
    expect(() => parseProfile(JSON.stringify(value))).toThrow(
      "Invalid toolchain profile",
    );
  });

  it("reports malformed JSON", () => {
    expect(() => parseProfile("{")).toThrow(SyntaxError);
  });
});

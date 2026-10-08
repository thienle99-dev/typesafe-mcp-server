import { describe, expect, it } from "vitest";
import { isAuthorized, loadHttpConfig } from "../src/httpAuth.js";

describe("loadHttpConfig", () => {
  it("binds to loopback by default without a token", () => {
    expect(loadHttpConfig({})).toEqual({ host: "127.0.0.1", authToken: undefined });
  });

  it("requires a token for a non-loopback host", () => {
    expect(() => loadHttpConfig({ HOST: "0.0.0.0" })).toThrow("MCP_AUTH_TOKEN");
    expect(loadHttpConfig({ HOST: "0.0.0.0", MCP_AUTH_TOKEN: "s3cret" })).toMatchObject({ host: "0.0.0.0" });
  });
});

describe("isAuthorized", () => {
  it("allows everything when no token is configured", () => {
    expect(isAuthorized(undefined, undefined)).toBe(true);
  });

  it("accepts only the matching bearer token", () => {
    expect(isAuthorized("Bearer s3cret", "s3cret")).toBe(true);
    expect(isAuthorized("Bearer wrong!", "s3cret")).toBe(false);
    expect(isAuthorized("s3cret", "s3cret")).toBe(false);
    expect(isAuthorized(undefined, "s3cret")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { dockerfilePort } from "../lib/dockerfile-port";

describe("dockerfilePort", () => {
  it("uses the last exposed TCP port when a base image declares another port", () => {
    expect(dockerfilePort("FROM example\nEXPOSE 3000\nEXPOSE 8000/tcp\n")).toBe(8000);
  });

  it("requires a numeric valid port", () => {
    expect(dockerfilePort("EXPOSE $PORT")).toBeNull();
    expect(dockerfilePort("EXPOSE 70000")).toBeNull();
  });
});

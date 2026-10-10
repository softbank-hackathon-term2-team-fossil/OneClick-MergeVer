import { describe, expect, it } from "vitest";
import { baseImages, missingBaseImages } from "../lib/dockerfile-images";

const dockerfile = `FROM --platform=$BUILDPLATFORM gradle:8-jdk-bookworm AS builder
RUN gradle build
FROM eclipse-temurin:17-jre-slim-bookworm
COPY --from=builder /app/app.jar app.jar
CMD ["java", "-jar", "app.jar"]`;

describe("base image check", () => {
  it("lists Docker Hub images and skips stages, scratch, variables and other registries", () => {
    expect(baseImages(dockerfile).map((image) => `${image.repository}:${image.reference}`)).toEqual(["library/gradle:8-jdk-bookworm", "library/eclipse-temurin:17-jre-slim-bookworm"]);
    expect(baseImages("FROM node:22 AS build\nFROM build AS test\nFROM scratch\nFROM $BASE\nFROM ghcr.io/o/i:1\nFROM docker.io/bitnami/nginx\nFROM python")
      .map((image) => `${image.repository}:${image.reference}`)).toEqual(["library/node:22", "bitnami/nginx:latest", "library/python:latest"]);
  });

  it("reports only the tags the registry answers 404 for", async () => {
    const fake = (async (url: string | URL | Request) => {
      const target = String(url);
      if (target.startsWith("https://auth.docker.io")) return new Response(JSON.stringify({ token: "t" }));
      return new Response(null, { status: target.includes("eclipse-temurin") ? 404 : 200 });
    }) as typeof fetch;
    expect(await missingBaseImages(dockerfile, fake)).toEqual(["eclipse-temurin:17-jre-slim-bookworm"]);
  });

  it("does not block when the registry cannot be reached", async () => {
    const failing = (async () => { throw new Error("offline"); }) as typeof fetch;
    expect(await missingBaseImages(dockerfile, failing)).toEqual([]);
  });
});

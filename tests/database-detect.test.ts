import { describe, expect, it } from "vitest";
import { detectDatabases } from "../lib/database/detect";

const file = (path: string, content: string) => ({ path, content, truncated: false });

describe("detectDatabases", () => {
  it("finds databases from Node dependencies", () => {
    const pkg = JSON.stringify({ dependencies: { pg: "^8", ioredis: "^5", mongoose: "^8" } });
    expect(detectDatabases([file("package.json", pkg)])).toEqual(["postgres", "mongo", "redis"]);
  });

  it("finds MySQL from mysql2", () => {
    expect(detectDatabases([file("package.json", '{"dependencies":{"mysql2":"^3"}}')])).toEqual(["mysql"]);
  });

  it("finds databases from Python requirements and pyproject", () => {
    expect(detectDatabases([file("requirements.txt", "flask==3\npsycopg2-binary==2.9\nredis==5.0\n")])).toEqual(["postgres", "redis"]);
    expect(detectDatabases([file("pyproject.toml", 'dependencies = ["pymysql>=1", "pymongo"]')])).toEqual(["mysql", "mongo"]);
    expect(detectDatabases([file("pyproject.toml", 'dependencies = ["redis>=5"]')])).toEqual(["redis"]);
  });

  it("finds databases from Go modules", () => {
    const mod = [
      "require (",
      "\tgithub.com/jackc/pgx/v5 v5.5.0",
      "\tgithub.com/go-sql-driver/mysql v1.8.0",
      "\tgo.mongodb.org/mongo-driver v1.15.0",
      "\tgithub.com/redis/go-redis/v9 v9.5.0",
      ")",
    ].join("\n");
    expect(detectDatabases([file("go.mod", mod)])).toEqual(["postgres", "mysql", "mongo", "redis"]);
    expect(detectDatabases([file("go.mod", "require github.com/lib/pq v1.10.9")])).toEqual(["postgres"]);
    // A dependency of a dependency is not the app's own database
    expect(detectDatabases([file("go.mod", "require (\n\tgithub.com/redis/go-redis/v9 v9.5.0 // indirect\n)")])).toEqual([]);
  });

  it("finds databases from Java builds", () => {
    const pom = "<dependency><groupId>org.postgresql</groupId><artifactId>postgresql</artifactId></dependency>"
      + "<artifactId>spring-boot-starter-data-redis</artifactId>";
    expect(detectDatabases([file("pom.xml", pom)])).toEqual(["postgres", "redis"]);
    const gradle = "implementation 'com.mysql:mysql-connector-j:8.4.0'\nimplementation 'org.springframework.boot:spring-boot-starter-data-mongodb'";
    expect(detectDatabases([file("build.gradle", gradle)])).toEqual(["mysql", "mongo"]);
  });

  it("reads the Prisma datasource provider", () => {
    const schema = 'generator client {\n  provider = "prisma-client-js"\n}\ndatasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}';
    expect(detectDatabases([file("prisma/schema.prisma", schema)])).toEqual(["postgres"]);
    expect(detectDatabases([file("schema.prisma", 'datasource db {\n provider = "mysql"\n}')])).toEqual(["mysql"]);
    expect(detectDatabases([file("schema.prisma", 'datasource db {\n provider = "mongodb"\n}')])).toEqual(["mongo"]);
    expect(detectDatabases([file("schema.prisma", 'datasource db {\n provider = "sqlite"\n}')])).toEqual([]);
  });

  it("ignores entry points and look-alike package names", () => {
    expect(detectDatabases([file("server.js", "const pg = require('pg')")])).toEqual([]);
    expect(detectDatabases([file("package.json", '{"dependencies":{"pg-format":"1","redis-mock":"1"}}')])).toEqual([]);
    expect(detectDatabases([file("requirements.txt", "django==5\n")])).toEqual([]);
  });
});

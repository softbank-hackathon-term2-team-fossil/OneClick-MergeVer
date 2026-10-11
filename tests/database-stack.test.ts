import { describe, expect, it } from "vitest";
import { createDataStack, managedDatabases } from "../lib/database/stack";

const network = "sbsb-net-abc123";

describe("createDataStack", () => {
  it("builds a Postgres stack on the app network without host ports", () => {
    const stack = createDataStack({ appId: "abc123", network, databases: [{ kind: "postgres", password: "pw-1" }] });
    const doc = JSON.parse(stack.compose);

    expect(stack.project).toBe("sbsb-data-abc123");
    expect(doc.name).toBe("sbsb-data-abc123");
    expect(doc.networks).toEqual({ [network]: { external: true } });
    expect(doc.volumes).toEqual({ pgdata: {} });
    const db = doc.services.db;
    expect(db.image).toBe("postgres:17-alpine");
    expect(db.ports).toBeUndefined();
    expect(db.restart).toBe("unless-stopped");
    expect(db.volumes).toEqual(["pgdata:/var/lib/postgresql/data"]);
    expect(db.networks).toEqual({ [network]: { aliases: ["db"] } });
    expect(db.healthcheck.test).toEqual(["CMD-SHELL", "pg_isready -h 127.0.0.1 -U app -d app"]);
  });

  it("keeps passwords out of the compose file", () => {
    const stack = createDataStack({ appId: "abc123", network, databases: [{ kind: "postgres", password: "secret-pw" }] });
    expect(stack.compose).not.toContain("secret-pw");
    expect(stack.compose).toContain("${POSTGRES_PASSWORD}");
    expect(stack.env).toEqual({ POSTGRES_PASSWORD: "secret-pw" });
  });

  it("gives the app connection URLs and individual DB_* values", () => {
    const stack = createDataStack({
      appId: "abc123",
      network,
      databases: [
        { kind: "postgres", password: "pg" },
        { kind: "redis", password: "" },
      ],
    });
    expect(stack.appEnv).toEqual({
      DATABASE_URL: "postgresql://app:pg@db:5432/app",
      REDIS_URL: "redis://cache:6379",
      DB_HOST: "db",
      DB_PORT: "5432",
      DB_USER: "app",
      DB_PASSWORD: "pg",
      DB_NAME: "app",
    });
  });

  it("uses MySQL as DATABASE_URL when it is the only relational database", () => {
    const stack = createDataStack({ appId: "a", network, databases: [{ kind: "mysql", password: "my", rootPassword: "root-pw" }] });
    expect(stack.env).toEqual({ MYSQL_PASSWORD: "my", MYSQL_ROOT_PASSWORD: "root-pw" });
    expect(stack.compose).not.toContain("root-pw");
    expect(stack.appEnv.MYSQL_URL).toBe("mysql://app:my@mysql:3306/app");
    expect(stack.appEnv.DATABASE_URL).toBe("mysql://app:my@mysql:3306/app");
    expect(stack.appEnv.DB_HOST).toBe("mysql");
    expect(stack.appEnv.DB_PORT).toBe("3306");
    const doc = JSON.parse(stack.compose);
    // SBSB sets the root password itself: MySQL prints a randomly generated one to its log
    expect(doc.services.mysql.environment.MYSQL_RANDOM_ROOT_PASSWORD).toBeUndefined();
    expect(doc.services.mysql.environment.MYSQL_ROOT_PASSWORD).toBe("${MYSQL_ROOT_PASSWORD}");
    // $$ survives compose interpolation as a literal $ inside the container's shell
    expect(doc.services.mysql.healthcheck.test[1]).toContain('"$$MYSQL_PASSWORD"');
  });

  it("prefers Postgres for DATABASE_URL when both relational databases are used", () => {
    const stack = createDataStack({
      appId: "a",
      network,
      databases: [
        { kind: "mysql", password: "my" },
        { kind: "postgres", password: "pg" },
      ],
    });
    expect(stack.appEnv.DATABASE_URL).toBe("postgresql://app:pg@db:5432/app");
    expect(stack.appEnv.MYSQL_URL).toBe("mysql://app:my@mysql:3306/app");
    expect(stack.appEnv.DB_HOST).toBe("db");
  });

  it("builds a MongoDB URL that authenticates against admin", () => {
    const stack = createDataStack({ appId: "a", network, databases: [{ kind: "mongo", password: "mg" }] });
    expect(stack.appEnv).toEqual({ MONGODB_URI: "mongodb://app:mg@mongo:27017/app?authSource=admin" });
    expect(stack.env).toEqual({ MONGO_PASSWORD: "mg" });
  });

  it("uses the image a database was created with, not the current template", () => {
    const stack = createDataStack({ appId: "a", network, databases: [{ kind: "postgres", password: "pg", image: "postgres:17.2-alpine" }] });
    expect(JSON.parse(stack.compose).services.db.image).toBe("postgres:17.2-alpine");
    expect(() => createDataStack({ appId: "a", network, databases: [{ kind: "postgres", password: "pg", image: "bad image" }] })).toThrow();
  });

  it("rejects an empty stack and unsafe identifiers", () => {
    expect(() => createDataStack({ appId: "a", network, databases: [] })).toThrow();
    expect(() => createDataStack({ appId: "a;rm", network, databases: [{ kind: "redis", password: "" }] })).toThrow();
    expect(() => createDataStack({ appId: "a", network, databases: [{ kind: "postgres", password: "bad pw" }] })).toThrow();
  });
});

describe("managedDatabases", () => {
  it("skips a database the user already points to with their own variable", () => {
    expect(managedDatabases(["postgres", "redis"], ["DATABASE_URL"])).toEqual(["redis"]);
    expect(managedDatabases(["mysql"], ["MYSQL_URL"])).toEqual([]);
    expect(managedDatabases(["mysql"], ["DATABASE_URL"])).toEqual([]);
    expect(managedDatabases(["mongo", "redis"], ["MONGODB_URI", "REDIS_URL"])).toEqual([]);
    expect(managedDatabases(["postgres"], ["API_KEY"])).toEqual(["postgres"]);
  });
});

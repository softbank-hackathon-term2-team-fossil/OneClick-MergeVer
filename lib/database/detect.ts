import type { AnalyzedFile } from "@/lib/types";

// Databases SBSB can run next to an on-premises app. The order is also the display order.
export const DATABASE_KINDS = ["postgres", "mysql", "mongo", "redis"] as const;
export type DatabaseKind = (typeof DATABASE_KINDS)[number];

// Only dependency manifests are searched: a database named in application code may be optional,
// but a declared driver is a strong signal. Entry points are deliberately left out.
const MANIFESTS = new Set([
  "package.json",
  "requirements.txt",
  "pyproject.toml",
  "Pipfile",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
]);

// A Python requirement name ends at a version specifier, an extra, a marker or the line end.
const PY_END = String.raw`(?=\s*(?:[=<>~!\[;"']|$))`;

const DRIVER_PATTERNS: Record<DatabaseKind, RegExp> = {
  postgres: /"(pg|postgres|pg-promise)"\s*:|psycopg|asyncpg|github\.com\/lib\/pq|github\.com\/jackc\/pgx|org\.postgresql/i,
  mysql: /"mysql2?"\s*:|mysqlclient|pymysql|aiomysql|github\.com\/go-sql-driver\/mysql|mysql-connector/i,
  mongo: /"(mongoose|mongodb)"\s*:|pymongo|go\.mongodb\.org\/mongo-driver|spring-boot-starter-data-mongodb|mongodb-driver/i,
  redis: new RegExp(
    String.raw`"(redis|ioredis)"\s*:|(?:^|[\s,\[])["']?redis${PY_END}|github\.com\/(redis|go-redis)\/go-redis|spring-boot-starter-data-redis|\bjedis\b|lettuce-core`,
    "im",
  ),
};

const PRISMA_PROVIDERS: Record<string, DatabaseKind> = { postgresql: "postgres", postgres: "postgres", mysql: "mysql", mongodb: "mongo" };

function prismaProvider(schema: string): DatabaseKind | null {
  const match = /datasource\s+\w+\s*\{[^}]*?provider\s*=\s*"([a-z]+)"/i.exec(schema);
  return match ? (PRISMA_PROVIDERS[match[1].toLowerCase()] ?? null) : null;
}

/** Databases the app declares in its build manifests or Prisma schema. */
export function detectDatabases(files: AnalyzedFile[]): DatabaseKind[] {
  const found = new Set<DatabaseKind>();
  for (const file of files) {
    const name = file.path.split("/").at(-1) ?? "";
    if (name === "schema.prisma") {
      const kind = prismaProvider(file.content);
      if (kind) found.add(kind);
    } else if (MANIFESTS.has(name)) {
      // go.mod also lists dependencies of dependencies, marked "// indirect"
      const content = name === "go.mod" ? file.content.split("\n").filter((line) => !line.includes("// indirect")).join("\n") : file.content;
      for (const kind of DATABASE_KINDS) if (DRIVER_PATTERNS[kind].test(content)) found.add(kind);
    }
  }
  return DATABASE_KINDS.filter((kind) => found.has(kind));
}

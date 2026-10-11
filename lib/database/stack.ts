// The "data stack": a compose project holding an app's databases on its on-premises server.
// It lives apart from the app containers, which keep their blue/green swap. The stack is kept
// across deployments and rollbacks, so its data survives in named volumes.
// The file is built from fixed templates (never AI) and never contains passwords: they stay
// ${VARIABLES} filled from an env file at `docker compose up` time.
import type { DatabaseKind } from "./detect";

export type DatabaseSpec = {
  kind: DatabaseKind;
  password: string;
  /** MySQL only: set by SBSB so MySQL never prints a generated one to its log */
  rootPassword?: string;
  /** The image the data volume was created with. Defaults to the current template */
  image?: string;
};

type Template = {
  service: string;
  image: string;
  port: number;
  volume: string;
  dataPath: string;
  passwordVariable?: string;
  rootPasswordVariable?: string;
  environment: Record<string, string>;
  healthcheck: string[];
  url?: (password: string) => string;
};

const USER = "app";
const NAME = "app";

// Major versions are pinned so a redeploy never upgrades a database's on-disk format.
export const TEMPLATES: Record<DatabaseKind, Template> = {
  postgres: {
    service: "db",
    image: "postgres:17-alpine",
    port: 5432,
    volume: "pgdata",
    dataPath: "/var/lib/postgresql/data",
    passwordVariable: "POSTGRES_PASSWORD",
    environment: { POSTGRES_USER: USER, POSTGRES_DB: NAME, POSTGRES_PASSWORD: "${POSTGRES_PASSWORD}" },
    // Over TCP: the temporary server used during first-time initialisation only listens on a socket.
    healthcheck: ["CMD-SHELL", `pg_isready -h 127.0.0.1 -U ${USER} -d ${NAME}`],
    url: (password) => `postgresql://${USER}:${password}@db:5432/${NAME}`,
  },
  mysql: {
    service: "mysql",
    image: "mysql:8.4",
    port: 3306,
    volume: "mysqldata",
    dataPath: "/var/lib/mysql",
    passwordVariable: "MYSQL_PASSWORD",
    rootPasswordVariable: "MYSQL_ROOT_PASSWORD",
    environment: { MYSQL_USER: USER, MYSQL_DATABASE: NAME, MYSQL_PASSWORD: "${MYSQL_PASSWORD}", MYSQL_ROOT_PASSWORD: "${MYSQL_ROOT_PASSWORD}" },
    healthcheck: ["CMD-SHELL", `mysqladmin ping -h 127.0.0.1 -u ${USER} -p"$$MYSQL_PASSWORD" --silent`],
    url: (password) => `mysql://${USER}:${password}@mysql:3306/${NAME}`,
  },
  mongo: {
    service: "mongo",
    image: "mongo:8",
    port: 27017,
    volume: "mongodata",
    dataPath: "/data/db",
    passwordVariable: "MONGO_PASSWORD",
    environment: { MONGO_INITDB_ROOT_USERNAME: USER, MONGO_INITDB_ROOT_PASSWORD: "${MONGO_PASSWORD}" },
    healthcheck: ["CMD", "mongosh", "--quiet", "--eval", "db.adminCommand('ping')"],
    url: (password) => `mongodb://${USER}:${password}@mongo:27017/${NAME}?authSource=admin`,
  },
  // Reachable only inside the app's own network, so it runs without a password.
  redis: {
    service: "cache",
    image: "redis:7-alpine",
    port: 6379,
    volume: "redisdata",
    dataPath: "/data",
    environment: {},
    healthcheck: ["CMD", "redis-cli", "ping"],
  },
};

const URL_VARIABLE: Record<DatabaseKind, string> = {
  postgres: "DATABASE_URL",
  mysql: "MYSQL_URL",
  mongo: "MONGODB_URI",
  redis: "REDIS_URL",
};

// A user-supplied variable that points the app at its own database switches the managed one off.
const USER_OVERRIDES: Record<DatabaseKind, string[]> = {
  postgres: ["DATABASE_URL"],
  mysql: ["MYSQL_URL", "DATABASE_URL"],
  mongo: ["MONGODB_URI"],
  redis: ["REDIS_URL"],
};

/** The detected databases SBSB should run, leaving out those the user connects to themselves. */
export function managedDatabases(kinds: DatabaseKind[], userVariables: string[]): DatabaseKind[] {
  const own = new Set(userVariables);
  return kinds.filter((kind) => !USER_OVERRIDES[kind].some((name) => own.has(name)));
}

/** The names of the variables SBSB hands the app for these databases. */
export function connectionVariableNames(kinds: DatabaseKind[]): string[] {
  const env = connectionEnv(kinds.map((kind) => ({ kind, password: "x" })));
  return Object.keys(env);
}

function connectionEnv(databases: DatabaseSpec[]): Record<string, string> {
  const byKind = new Map(databases.map((database) => [database.kind, database]));
  const env: Record<string, string> = {};
  for (const { kind, password } of databases) {
    const template = TEMPLATES[kind];
    env[URL_VARIABLE[kind]] = template.url ? template.url(password) : `redis://${template.service}:${template.port}`;
  }
  // DATABASE_URL and the DB_* values describe the relational database, Postgres first.
  const primary = byKind.get("postgres") ?? byKind.get("mysql");
  if (!primary) return env;
  const template = TEMPLATES[primary.kind];
  if (!env.DATABASE_URL) env.DATABASE_URL = env[URL_VARIABLE[primary.kind]];
  return {
    ...env,
    DB_HOST: template.service,
    DB_PORT: String(template.port),
    DB_USER: USER,
    DB_PASSWORD: primary.password,
    DB_NAME: NAME,
  };
}

const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
// Generated passwords are base64url; anything else could break a URL or the env file.
const SAFE_PASSWORD = /^[A-Za-z0-9_-]*$/;
const SAFE_IMAGE = /^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9._-]+$/;

export type DataStack = {
  /** Compose project name, also the prefix of its containers and volumes */
  project: string;
  /** Compose file (JSON, which compose reads as YAML) */
  compose: string;
  /** Values for the compose ${VARIABLES}: passed with --env-file, never written to the server's disk */
  env: Record<string, string>;
  /** Connection settings handed to the app container */
  appEnv: Record<string, string>;
};

export function createDataStack(input: { appId: string; network: string; databases: DatabaseSpec[] }): DataStack {
  if (input.databases.length === 0) throw new Error("A data stack needs at least one database.");
  if (!SAFE_ID.test(input.appId) || !SAFE_ID.test(input.network)) throw new Error("Unsafe data stack name.");
  if (input.databases.some((database) => !SAFE_PASSWORD.test(database.password) || !SAFE_PASSWORD.test(database.rootPassword ?? ""))) {
    throw new Error("Database passwords must be URL-safe.");
  }
  if (input.databases.some((database) => database.image !== undefined && !SAFE_IMAGE.test(database.image))) {
    throw new Error("Invalid database image.");
  }

  const project = `sbsb-data-${input.appId}`;
  const services: Record<string, unknown> = {};
  const volumes: Record<string, object> = {};
  const env: Record<string, string> = {};
  for (const { kind, password, rootPassword, image } of input.databases) {
    const template = TEMPLATES[kind];
    services[template.service] = {
      image: image ?? template.image,
      restart: "unless-stopped",
      ...(Object.keys(template.environment).length > 0 ? { environment: template.environment } : {}),
      volumes: [`${template.volume}:${template.dataPath}`],
      healthcheck: { test: template.healthcheck, interval: "3s", timeout: "5s", retries: 40, start_period: "10s" },
      networks: { [input.network]: { aliases: [template.service] } },
      labels: { "sbsb.app": input.appId },
    };
    volumes[template.volume] = {};
    if (template.passwordVariable) env[template.passwordVariable] = password;
    if (template.rootPasswordVariable) env[template.rootPasswordVariable] = rootPassword || password;
  }

  const compose = JSON.stringify(
    { name: project, services, volumes, networks: { [input.network]: { external: true } } },
    null,
    2,
  );
  return { project, compose, env, appEnv: connectionEnv(input.databases) };
}

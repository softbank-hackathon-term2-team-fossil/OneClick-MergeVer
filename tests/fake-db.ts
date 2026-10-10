// An in-memory stand-in for the Prisma client, covering only the calls SBSB makes.
// It keeps unit tests fast and database-free; tests/db.integration.test.ts checks the same
// behaviour against a real Postgres.
type Row = Record<string, unknown>;

const matches = (row: Row, where: Row = {}) => Object.entries(where).every(([key, value]) => row[key] === value);

// Compound unique keys ({ projectId_kind: { projectId, kind } }) are matched field by field.
const flatten = (where: Row): Row =>
  Object.fromEntries(Object.entries(where).flatMap(([key, value]) =>
    key.includes("_") && value && typeof value === "object" && !(value instanceof Date) ? Object.entries(value as Row) : [[key, value]]));

// A table keyed by id with the calls the project database and variable stores make.
function createTable(rows: Row[], nextId: () => string) {
  const copy = (row: Row | undefined) => (row ? { ...row } : null);
  return {
    async findMany({ where }: { where?: Row } = {}) {
      return rows.filter((row) => matches(row, where)).map((row) => ({ ...row }));
    },
    async findUnique({ where }: { where: Row }) {
      return copy(rows.find((row) => matches(row, flatten(where))));
    },
    async create({ data }: { data: Row }) {
      const row = { id: nextId(), createdAt: new Date(), updatedAt: new Date(), ...data };
      rows.push(row);
      return { ...row };
    },
    async update({ where, data }: { where: Row; data: Row }) {
      const row = rows.find((item) => matches(item, flatten(where)));
      if (!row) throw new Error("Record to update not found.");
      Object.assign(row, data, { updatedAt: new Date() });
      return { ...row };
    },
    async upsert({ where, create, update }: { where: Row; create: Row; update: Row }) {
      const row = rows.find((item) => matches(item, flatten(where)));
      if (row) {
        Object.assign(row, update, { updatedAt: new Date() });
        return { ...row };
      }
      const created = { id: nextId(), createdAt: new Date(), updatedAt: new Date(), ...create };
      rows.push(created);
      return { ...created };
    },
    async deleteMany({ where }: { where: Row }) {
      const before = rows.length;
      for (let index = rows.length - 1; index >= 0; index--) if (matches(rows[index], where)) rows.splice(index, 1);
      return { count: before - rows.length };
    },
  };
}

export function createFakeDb() {
  const projects: Row[] = [];
  const servers: Row[] = [];
  const deployments: Row[] = [];
  let sequence = 0;
  const nextId = () => `id-${++sequence}`;
  // Prisma hands back rows that are safe to keep; return copies so tests cannot mutate the "database".
  const copy = <T extends Row | null>(row: T): T => (row ? { ...row } as T : row);

  const client = {
    project: {
      async findUnique({ where }: { where: { installationId_repository: Row } }) {
        return copy(projects.find((row) => matches(row, where.installationId_repository)) ?? null);
      },
      async findUniqueOrThrow({ where }: { where: { installationId_repository: Row } }) {
        const row = projects.find((item) => matches(item, where.installationId_repository));
        if (!row) throw new Error("No Project found");
        return copy(row);
      },
      async upsert({ where, create }: { where: { installationId_repository: Row }; create: Row }) {
        let row = projects.find((item) => matches(item, where.installationId_repository));
        if (!row) {
          row = { id: nextId(), ...create };
          projects.push(row);
        }
        return copy(row);
      },
    },
    server: {
      async findUnique({ where }: { where: Row }) {
        return copy(servers.find((row) => matches(row, where)) ?? null);
      },
      async upsert({ where, create, update }: { where: Row; create: Row; update: Row }) {
        let row = servers.find((item) => matches(item, where));
        if (row) Object.assign(row, update, { updatedAt: new Date() });
        else {
          row = { id: nextId(), ...create, updatedAt: new Date() };
          servers.push(row);
        }
        return copy(row);
      },
      async deleteMany({ where }: { where: Row }) {
        const before = servers.length;
        for (let index = servers.length - 1; index >= 0; index--) if (matches(servers[index], where)) servers.splice(index, 1);
        return { count: before - servers.length };
      },
    },
    deployment: {
      async findFirst({ where, orderBy }: { where?: Row; orderBy?: { number: "desc" } }) {
        const found = deployments.filter((row) => matches(row, where));
        if (orderBy) found.sort((a, b) => (b.number as number) - (a.number as number));
        return copy(found[0] ?? null);
      },
      async findMany({ where, take }: { where?: Row; take?: number }) {
        return deployments.filter((row) => matches(row, where))
          .sort((a, b) => (b.number as number) - (a.number as number))
          .slice(0, take)
          .map((row) => ({ ...row }));
      },
      async create({ data }: { data: Row }) {
        const row = { id: nextId(), trigger: "MANUAL", status: "RUNNING", failureReason: null, url: null, destination: null, startedAt: new Date(), finishedAt: null, ...data };
        deployments.push(row);
        return copy(row);
      },
      async update({ where, data }: { where: Row; data: Row }) {
        const row = deployments.find((item) => matches(item, where));
        if (!row) throw new Error("Record to update not found.");
        Object.assign(row, data);
        return copy(row);
      },
      async updateMany({ where, data }: { where: Row; data: Row }) {
        const found = deployments.filter((row) => matches(row, where));
        for (const row of found) Object.assign(row, data);
        return { count: found.length };
      },
    },
    projectDatabase: createTable([], nextId),
    projectEnvVar: createTable([], nextId),
    async $queryRaw() {
      return [];
    },
    async $transaction<T>(run: (tx: unknown) => Promise<T>): Promise<T> {
      return run(client);
    },
  };
  return client;
}

// An in-memory stand-in for the Prisma client, covering only the calls SBSB makes.
// It keeps unit tests fast and database-free; tests/db.integration.test.ts checks the same
// behaviour against a real Postgres.
type Row = Record<string, unknown>;

const matches = (row: Row, where: Row = {}) => Object.entries(where).every(([key, value]) => row[key] === value);

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
    async $queryRaw() {
      return [];
    },
    async $transaction<T>(run: (tx: unknown) => Promise<T>): Promise<T> {
      return run(client);
    },
  };
  return client;
}

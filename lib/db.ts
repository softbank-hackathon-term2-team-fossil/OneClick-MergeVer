import "server-only";

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

function createPrismaClient() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set. See .env.example.");
  }
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

// One client per process, kept on globalThis so dev hot reloads do not open new connections.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

// Created on first use so that building or importing a route does not require a database.
export function db(): PrismaClient {
  globalForPrisma.prisma ??= createPrismaClient();
  return globalForPrisma.prisma;
}

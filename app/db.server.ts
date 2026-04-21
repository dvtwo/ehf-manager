import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var prismaClient: PrismaClient | undefined;
}

// Reuse the client in development to avoid exhausting connections on hot reload.
const prisma = global.prismaClient ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  global.prismaClient = prisma;
}

export default prisma;

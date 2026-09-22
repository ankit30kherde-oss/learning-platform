/**
 * Seeds an admin and a demo student so you can sign in immediately.
 * Run: pnpm --filter auth-service seed
 */
import { PrismaClient, Role, UserStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const rounds = Number(process.env.BCRYPT_ROUNDS ?? 12);

  const admin = {
    email: 'admin@devopsacademy.local',
    fullName: 'Platform Admin',
    password: 'Admin-Passw0rd',
    roles: [Role.ADMIN, Role.INSTRUCTOR],
  };
  const student = {
    email: 'student@devopsacademy.local',
    fullName: 'Demo Student',
    password: 'Student-Passw0rd',
    roles: [Role.STUDENT],
  };

  for (const u of [admin, student]) {
    await prisma.user.upsert({
      where: { email: u.email },
      update: {},
      create: {
        email: u.email,
        fullName: u.fullName,
        passwordHash: await bcrypt.hash(u.password, rounds),
        roles: u.roles,
        status: UserStatus.ACTIVE,
        emailVerifiedAt: new Date(),
        passwordChangedAt: new Date(),
      },
    });
    console.log(`seeded ${u.email} / ${u.password}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

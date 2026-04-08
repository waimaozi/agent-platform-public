import { prisma } from "@agent-platform/core";
import { seedProjectsFromMarkdown } from "../apps/api/src/lib/project-tracker.js";

async function main() {
  const seeded = await seedProjectsFromMarkdown(prisma);
  console.log(`Seeded ${seeded.length} projects from docs/PROJECTS.md`);
}

await main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

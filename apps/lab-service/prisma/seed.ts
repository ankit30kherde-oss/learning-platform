/**
 * Lab templates. The ids are deterministic so course-service's seed can point
 * LAB lessons at them without a cross-database join or a lookup at boot.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const LINUX_BASICS_ID = '7b3f1a10-0000-4000-8000-000000001a01';
const DOCKER_ID = '7b3f1a10-0000-4000-8000-000000001a02';
const K8S_ID = '7b3f1a10-0000-4000-8000-000000001a03';

async function main() {
  const templates = [
    {
      id: LINUX_BASICS_ID,
      slug: 'linux-basics',
      title: 'Linux fundamentals sandbox',
      description:
        'A throwaway shell for practising navigation, permissions, pipes and process inspection. No network, no root, destroyed when you leave.',
      image: process.env.LAB_IMAGE ?? 'alpine:3.20',
      shell: '/bin/sh',
      ttlSeconds: 1800,
      idleTimeoutSeconds: 600,
      allowEgress: false,
    },
    {
      id: DOCKER_ID,
      slug: 'docker-basics',
      title: 'Container fundamentals sandbox',
      description: 'Build and inspect images. Egress is allowed to a mirrored registry only.',
      image: process.env.LAB_IMAGE ?? 'alpine:3.20',
      shell: '/bin/sh',
      ttlSeconds: 2400,
      idleTimeoutSeconds: 900,
      memoryLimit: '1Gi',
      cpuLimit: '1',
      allowEgress: false,
    },
    {
      id: K8S_ID,
      slug: 'k8s-basics',
      title: 'Kubernetes CLI sandbox',
      description:
        'kubectl against a disposable cluster-in-a-pod. Used by the CrashLoopBackOff debugging lesson.',
      image: process.env.LAB_IMAGE ?? 'alpine:3.20',
      shell: '/bin/sh',
      ttlSeconds: 2700,
      idleTimeoutSeconds: 900,
      memoryLimit: '1Gi',
      cpuLimit: '1',
      allowEgress: false,
    },
  ];

  // The course seed refers to templates by slug, so add the remaining ones it
  // mentions rather than leaving a LAB lesson pointing at nothing.
  templates.push({
    id: '7b3f1a10-0000-4000-8000-000000001a04',
    slug: 'terraform-basics',
    title: 'Terraform sandbox',
    description: 'terraform plan/apply against a local backend. No cloud credentials are ever injected.',
    image: process.env.LAB_IMAGE ?? 'alpine:3.20',
    shell: '/bin/sh',
    ttlSeconds: 2700,
    idleTimeoutSeconds: 900,
    allowEgress: false,
  } as (typeof templates)[number]);

  for (const t of templates) {
    await prisma.labTemplate.upsert({ where: { id: t.id }, update: t, create: t });
  }

  console.log(`seeded ${templates.length} lab templates`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

/**
 * Seeds the catalog with a real, publishable DevOps/SRE course plus a second
 * (draft) course so you can see filtering, and proves the model supports any
 * future subject without a schema change.
 *
 * Run: pnpm --filter course-service seed
 */
import { CourseLevel, CourseStatus, LessonType, PrismaClient, ResourceKind } from '@prisma/client';

const prisma = new PrismaClient();

// Stable id so re-seeding is idempotent. In real life this is the admin's
// user id from auth_db (services share ids, not tables).
const INSTRUCTOR_ID = '00000000-0000-4000-8000-000000000001';

async function main() {
  const devops = await prisma.category.upsert({
    where: { slug: 'devops' },
    update: {},
    create: { slug: 'devops', name: 'DevOps & SRE', sortOrder: 1, description: 'Ship and operate reliable systems.' },
  });
  await prisma.category.upsert({
    where: { slug: 'cloud' },
    update: {},
    create: { slug: 'cloud', name: 'Cloud & Infrastructure', sortOrder: 2 },
  });
  await prisma.category.upsert({
    where: { slug: 'programming' },
    update: {},
    create: { slug: 'programming', name: 'Programming', sortOrder: 3 },
  });

  // Fixed id so quiz-service and certificate-service can reference this course
  // from their own databases without a cross-database lookup.
  const COURSE_ID = '5a1c9e20-0000-4000-8000-000000000c01';

  const course = await prisma.course.upsert({
    where: { slug: 'devops-sre-engineering' },
    update: {},
    create: {
      id: COURSE_ID,
      slug: 'devops-sre-engineering',
      title: 'DevOps & SRE Engineering',
      subtitle: 'Linux, Docker, Kubernetes, Terraform and CI/CD, with hands-on labs in your browser',
      description: [
        'A practical path from Linux fundamentals to running services on Kubernetes.',
        'Every module ends in a live lab: you get a real shell, not a video of one.',
        'By the end you can build a pipeline, containerise a service, deploy it to a cluster and keep it running.',
      ].join('\n\n'),
      outcomes: [
        'Work confidently in a Linux shell',
        'Containerise an application and debug it when it breaks',
        'Deploy and operate workloads on Kubernetes',
        'Provision AWS infrastructure with Terraform',
        'Build a CI/CD pipeline with automated tests and scans',
        'Instrument a service and respond to alerts',
      ],
      prerequisites: ['A laptop and a browser', 'No prior DevOps experience required'],
      level: CourseLevel.BEGINNER,
      status: CourseStatus.PUBLISHED,
      publishedAt: new Date(),
      priceMinor: 499900, // Rs 4,999.00
      listPriceMinor: 999900,
      currency: 'INR',
      categoryId: devops.id,
      instructorId: INSTRUCTOR_ID,
      instructorName: 'Platform Admin',
      tags: ['linux', 'docker', 'kubernetes', 'terraform', 'aws', 'ci-cd'],
      thumbnailKey: 'public/thumbnails/devops-sre.jpg',
    },
  });

  const modules: Array<{
    title: string;
    summary: string;
    isPreview?: boolean;
    lessons: Array<{
      title: string;
      type: LessonType;
      isPreview?: boolean;
      duration?: number;
      labTemplateId?: string;
      quizId?: string;
      notes?: string;
    }>;
  }> = [
    {
      title: 'Getting started',
      summary: 'How the course works and how to use the labs.',
      isPreview: true,
      lessons: [
        {
          title: 'Welcome and how to use this course',
          type: LessonType.VIDEO,
          isPreview: true,
          duration: 420,
          notes: '## Welcome\n\nWatch this first. It explains the lab environment and how to get help.\n\n- Labs open in your browser, no install needed\n- Each module ends with a graded exercise\n',
        },
        {
          title: 'What DevOps and SRE actually mean',
          type: LessonType.VIDEO,
          isPreview: true,
          duration: 660,
          notes: '## Definitions that matter\n\nDevOps is a way of working. SRE is one concrete implementation of it, with error budgets and SLOs.\n',
        },
      ],
    },
    {
      title: 'Linux fundamentals',
      summary: 'The shell skills everything else is built on.',
      lessons: [
        { title: 'The filesystem and navigation', type: LessonType.VIDEO, duration: 900,
          notes: '## Paths\n\n`pwd` prints where you are. `cd` moves. `ls -la` lists everything including hidden files.\n' },
        { title: 'Files, permissions and ownership', type: LessonType.VIDEO, duration: 1080,
          notes: '## chmod and chown\n\nPermissions are three triples: owner, group, other.\n\n```bash\nchmod 640 secrets.txt\nchown app:app secrets.txt\n```\n' },
        { title: 'Processes, signals and services', type: LessonType.VIDEO, duration: 960 },
        { title: 'Lab: your first Linux shell', type: LessonType.LAB, labTemplateId: 'linux-basics',
          notes: '## Your task\n\n1. Create a directory `workspace`\n2. Create `notes.txt` inside it\n3. Write your name into the file\n4. Make it readable only by you\n' },
        // Deterministic id shared with quiz-service's seed: the two databases
        // cannot join, so the contract is the uuid itself.
        { title: 'Linux fundamentals check', type: LessonType.QUIZ, quizId: '9c2e4d80-0000-4000-8000-000000001c01' },
      ],
    },
    {
      title: 'Containers with Docker',
      summary: 'Images, layers, registries and debugging containers.',
      lessons: [
        { title: 'Why containers exist', type: LessonType.VIDEO, duration: 720 },
        { title: 'Writing a production Dockerfile', type: LessonType.VIDEO, duration: 1320,
          notes: '## Multi-stage builds\n\nBuild in one stage, copy only the artefact into a slim runtime stage. Run as a non-root user.\n' },
        { title: 'Lab: build and run a container', type: LessonType.LAB, labTemplateId: 'docker-basics' },
      ],
    },
    {
      title: 'Kubernetes in practice',
      summary: 'Pods, deployments, services and how to debug them.',
      lessons: [
        { title: 'The Kubernetes object model', type: LessonType.VIDEO, duration: 1200 },
        { title: 'Deployments, services and ingress', type: LessonType.VIDEO, duration: 1500 },
        { title: 'Lab: deploy your first workload', type: LessonType.LAB, labTemplateId: 'k8s-basics' },
        { title: 'Kubernetes check', type: LessonType.QUIZ, quizId: '9c2e4d80-0000-4000-8000-000000001c02' },
      ],
    },
    {
      title: 'Infrastructure as code with Terraform',
      summary: 'Providers, state, modules and safe changes.',
      lessons: [
        { title: 'State, plan and apply', type: LessonType.VIDEO, duration: 1080 },
        { title: 'Writing reusable modules', type: LessonType.VIDEO, duration: 1260 },
        { title: 'Lab: provision with Terraform', type: LessonType.LAB, labTemplateId: 'terraform-basics' },
      ],
    },
    {
      title: 'CI/CD and observability',
      summary: 'Pipelines that catch problems, and dashboards that explain them.',
      lessons: [
        { title: 'Designing a pipeline', type: LessonType.VIDEO, duration: 1140 },
        { title: 'Metrics, logs and traces', type: LessonType.VIDEO, duration: 1380 },
        { title: 'Final assignment', type: LessonType.ASSIGNMENT },
      ],
    },
  ];

  let moduleOrder = 0;
  for (const m of modules) {
    const created = await prisma.courseModule.upsert({
      where: { courseId_sortOrder: { courseId: course.id, sortOrder: moduleOrder } },
      update: { title: m.title, summary: m.summary },
      create: {
        courseId: course.id,
        title: m.title,
        summary: m.summary,
        sortOrder: moduleOrder,
        isPreview: m.isPreview ?? false,
      },
    });

    let lessonOrder = 0;
    for (const l of m.lessons) {
      const slug = slugify(l.title);
      await prisma.lesson.upsert({
        where: { courseId_slug: { courseId: course.id, slug } },
        update: {},
        create: {
          moduleId: created.id,
          courseId: course.id,
          title: l.title,
          slug,
          type: l.type,
          contentMarkdown: l.notes ?? `## ${l.title}\n\nNotes for this lesson.`,
          // Demo object keys. media-service signs these; they are never public.
          videoKey: l.type === LessonType.VIDEO ? `courses/${course.slug}/${slug}.mp4` : null,
          videoDuration: l.duration ?? 0,
          isPreview: l.isPreview ?? false,
          labTemplateId: l.labTemplateId,
          quizId: l.quizId,
          sortOrder: lessonOrder,
        },
      });
      lessonOrder++;
    }
    moduleOrder++;
  }

  // Attach a PDF to the first Linux lesson so the notes flow is testable.
  const first = await prisma.lesson.findFirst({
    where: { courseId: course.id, slug: 'the-filesystem-and-navigation' },
  });
  if (first) {
    const exists = await prisma.lessonResource.findFirst({ where: { lessonId: first.id } });
    if (!exists) {
      await prisma.lessonResource.create({
        data: {
          lessonId: first.id,
          kind: ResourceKind.PDF,
          title: 'Linux command cheat sheet (PDF)',
          storageKey: `courses/${course.slug}/notes/linux-cheatsheet.pdf`,
          mimeType: 'application/pdf',
          sizeBytes: 184320,
        },
      });
    }
  }

  const counts = await prisma.lesson.aggregate({
    where: { courseId: course.id, deletedAt: null },
    _count: { _all: true },
    _sum: { videoDuration: true },
  });
  await prisma.course.update({
    where: { id: course.id },
    data: {
      lessonCount: counts._count._all,
      durationMinutes: Math.round((counts._sum.videoDuration ?? 0) / 60),
    },
  });

  // A second course, to prove the catalog is not DevOps-specific.
  await prisma.course.upsert({
    where: { slug: 'python-for-automation' },
    update: {},
    create: {
      slug: 'python-for-automation',
      title: 'Python for Automation',
      subtitle: 'Scripting, APIs and tooling for infrastructure engineers',
      description: 'Write the small programs that hold a platform together: log parsers, API clients, deployment helpers.',
      level: CourseLevel.BEGINNER,
      status: CourseStatus.DRAFT,
      priceMinor: 299900,
      currency: 'INR',
      instructorId: INSTRUCTOR_ID,
      instructorName: 'Platform Admin',
      tags: ['python', 'automation'],
    },
  });

  await prisma.coupon.upsert({
    where: { code: 'LAUNCH50' },
    update: {},
    create: {
      code: 'LAUNCH50',
      description: 'Launch offer - 50% off',
      discountType: 'PERCENT',
      discountValue: 50,
      maxRedemptions: 500,
      expiresAt: new Date(Date.now() + 90 * 24 * 3600 * 1000),
    },
  });

  console.log(`seeded course "${course.title}" with ${counts._count._all} lessons`);
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 140);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

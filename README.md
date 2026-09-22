# DevOps Academy — Online Learning Platform

A production-shaped, microservices learning platform for DevOps/SRE training:
Next.js + TypeScript frontend, eleven NestJS services, PostgreSQL with one
database per service, Redis, Razorpay payments, protected video/PDF delivery,
real browser Linux labs, quizzes, certificates and email notifications.

This README gets you from a fresh GitHub Codespace to a working platform, and
tells you exactly what runs there versus what needs real AWS/Razorpay/Kubernetes.

---

## 1. Architecture at a glance

```
                                   ┌─────────────┐
                                   │   web (3000) │  Next.js, HttpOnly cookies
                                   └──────┬───────┘
                                          │ /api/* rewrite
                                   ┌──────▼───────┐
                                   │ api-gateway  │  (4000) verifies JWT, proxies, WS
                                   └──────┬───────┘
        ┌───────────┬───────────┬────────┼────────┬───────────┬────────────┐
        ▼           ▼           ▼        ▼         ▼           ▼            ▼
      auth       course    enrollment  payment    media       lab         quiz
     (4001)      (4002)     (4003)     (4004)    (4005)      (4006)      (4007)
        │           │           │          │         │           │           │
     auth_db    course_db  enrollment_db payment_db media_db   lab_db     quiz_db
                                          │
                              ┌───────────┴───────────┐
                              ▼                        ▼
                       certificate (4008)      notification (4009)
                       certificate_db          notification_db

  Redis: dev event bus (Pub/Sub) + cache        ->  EventBridge/SQS in prod
  MinIO: dev S3-compatible object store         ->  S3 + CloudFront in prod
  MailHog: dev SMTP catcher (localhost:8025)    ->  Amazon SES in prod
```

Every service verifies the access-token JWT itself — the gateway's identity
headers are a logging convenience, not a trust boundary. Every service owns
one database and is reached by every other service only through its
`internal/*` routes, guarded by a shared internal API key.

## 2. What works in Codespaces vs what needs real infrastructure

| Capability | In Codespaces | In production |
|---|---|---|
| Browse, register, verify email, log in | full | full |
| Enrol in the free/demo course | full | full |
| Buy the paid course | Razorpay **test mode** | Razorpay live |
| Watch a lesson video | placeholder file, signed MinIO URL | real video, signed CloudFront URL |
| Download lesson notes (PDF) | placeholder file | real PDF |
| Take a quiz | full, real server-side grading | full |
| Linux lab terminal | full, via a local Docker container | full, via a per-session Kubernetes namespace |
| Certificate issue + public verification | full | full |
| Email notifications | full, caught by MailHog at `:8025` | full, via SES |
| Admin course/quiz management | full | full |
| Autoscaling, multi-AZ, WAF, CloudFront | not applicable | Terraform-provisioned |

The one deliberate behavioural difference: `LAB_DRIVER=local` runs student
shells as Docker containers on the Codespace's own daemon (still non-root, no
network, capabilities dropped — see
`apps/lab-service/src/labs/drivers/local-docker.driver.ts`). Production sets
`LAB_DRIVER=kubernetes`, which gives each session its own namespace,
ResourceQuota, NetworkPolicy and Pod Security Standard enforcement
(`kubernetes.driver.ts`). The lesson works identically either way; only the
isolation mechanism underneath changes.

## 3. Quick start (GitHub Codespaces)

1. Push this repository to GitHub.
2. On the repo page: **Code -> Codespaces -> Create codespace on main**.
3. Wait for the container to build and `post-create.sh` to finish — it runs
   `pnpm install`, copies `.env.example` to `.env`, and builds the shared
   package. This takes 2-4 minutes.
4. Start the backing services (Postgres, Redis, MailHog, MinIO):
   ```bash
   docker compose up -d
   ```
5. Run migrations and seed the demo data:
   ```bash
   pnpm db:migrate
   pnpm db:seed
   ```
6. Create the MinIO bucket and placeholder media (optional but recommended):
   ```bash
   bash scripts/bootstrap-minio.sh
   ```
7. Start everything:
   ```bash
   pnpm dev
   ```
8. When VS Code's "Ports" tab shows port **3000** forwarded, open it — that's
   the app.
9. For the lab terminal to reach the gateway's WebSocket, set
   `NEXT_PUBLIC_GATEWAY_WS_URL` in `.env` to the **forwarded HTTPS URL of port
   4000** shown in the Ports tab (right-click it -> Copy URL), then restart
   `pnpm dev`. On plain localhost this step is unnecessary.

To run everything as containers instead of `pnpm dev` on the host:
```bash
docker compose -f docker-compose.yml -f docker-compose.full.yml up --build
```

## 4. Quick start (local machine, not Codespaces)

Prerequisites: Node 22, pnpm 9.15.4
(`corepack enable && corepack prepare pnpm@9.15.4 --activate`), Docker.

```bash
git clone <your-repo-url> && cd learning-platform
cp .env.example .env
pnpm install
docker compose up -d
pnpm db:migrate
pnpm db:seed
bash scripts/bootstrap-minio.sh   # optional
pnpm dev
```

Open http://localhost:3000.

## 5. The 25-step walkthrough

Follow this top to bottom on a fresh `pnpm dev` to confirm every major system
is wired correctly. About ten minutes.

1. **Open http://localhost:3000.** The landing page should show a
   terminal-transcript hero, not a blank page or a 502.
2. **Click "Courses"** in the header. The DevOps & SRE Engineering course
   should appear with a real price (Rs 4,999, struck through from Rs 9,999).
3. **Open the course.** The curriculum accordion should list six modules;
   the first is marked "Preview".
4. **Click a preview lesson** ("Welcome and how to use this course") without
   signing in. It should load — proving the gateway's entitlement check
   correctly treats preview lessons as public.
5. **Click "Create account."** Register with any email — no real mailbox
   needed, MailHog catches everything.
6. **Open http://localhost:8025** (MailHog). A verification email addressed
   to the account you just created should be there.
7. **Click the verification link** in that email. You should land on
   `/verify-email` and see "verified".
8. **Sign in** with the account. You should land on `/dashboard`, initially
   empty ("You have not enrolled in anything yet").
9. **Go to Courses -> DevOps & SRE Engineering -> Buy this course.** You
   should land on `/checkout/devops-sre-engineering` with the price broken
   out.
10. **Try the coupon `LAUNCH50`** and click Apply. The total should drop —
    proving discounts are computed server-side (payment-service asks
    course-service for the price and validates the coupon, never trusting the
    browser).
11. **Click "Pay securely."** The Razorpay Checkout modal should open with the
    course name and the discounted amount.
12. **Pay with the test card** `4111 1111 1111 1111`, any future expiry, any
    CVV, OTP `1234`. You should see "Payment confirmed" and be redirected into
    the course.
13. **Open MailHog again.** A payment receipt email should have arrived —
    proof the `payment.completed` event reached notification-service.
14. **Go to `/dashboard`.** The course should now appear with 0% progress.
15. **Open the first lesson with a video** ("The filesystem and navigation").
    The player should load and start — the URL it requests
    (`/api/media/lessons/:id/playback`) is signed and expires in minutes; open
    dev tools and reload to see the query string change each time.
16. **Open the lesson's downloadable PDF** on the same lesson. Clicking "Open"
    should sign and open a new tab — not link directly to a static file.
17. **Click "Mark complete and continue."** The sidebar checkmark should fill
    in and progress should tick up.
18. **Navigate to the Linux lab lesson** ("Lab: your first Linux shell") and
    click **"Launch lab."** Within a few seconds a real shell prompt should
    appear.
19. **Type `whoami`, then `id`.** You should see a non-root user (uid 1000).
    Try `ping 8.8.8.8` — it should hang or fail, since the lab container has
    no network.
20. **Click "End session."** The terminal should show it disconnected. This
    exercises the same code path (`labs.service.ts`'s `stop()`) that the
    30-minute idle timeout uses automatically.
21. **Open the "Linux fundamentals check" quiz lesson.** Answer all four
    questions and submit. You should see a score and per-question feedback —
    but never the correct answers before you submit (check the Network tab:
    the `GET /quizzes/:id` response contains no `isCorrect` field anywhere).
22. **Keep completing lessons** until the course reaches 100%.
23. **Open MailHog once more.** A "you finished the course" email and a "your
    certificate is ready" email should both have arrived within a few
    seconds — proving the `progress.course_completed` -> `certificate.issued`
    -> notification chain works end to end.
24. **Fetch your certificate**: `GET http://localhost:4000/certificates/me`
    (with your session cookie — easiest via the browser while signed in, or
    the Swagger UI at `http://localhost:4008/docs`). Copy the `serial`.
25. **Verify it publicly**, with no login, by hitting
    `GET http://localhost:4000/certificates/verify/<serial>` — you should get
    back `{"valid": true, ...}` with the recipient's name and the course
    title. This is the exact endpoint an employer would use.

If all 25 steps pass, every service, every database, the event bus, the
signed-media path, the payment webhook, the lab isolation and the
certificate pipeline are all correctly wired together.

## 6. Everyday commands

```bash
pnpm dev            # everything: gateway + all 9 backend services + web
pnpm dev:core        # just the Phase-1 path: gateway, auth, course, enrollment, payment, web
pnpm health          # curl every /healthz and report a pass/fail table
pnpm db:migrate       # prisma migrate deploy, in dependency order, all services
pnpm db:seed          # course catalog, lab templates, quizzes, demo users
pnpm db:reset          # nuke volumes, recreate, migrate, seed - a clean slate
pnpm test              # unit tests, every service
pnpm test:e2e           # Playwright, against whatever is on :3000
pnpm lint / typecheck    # across the whole workspace
```

Demo accounts (from the seed):

| Email | Password | Role |
|---|---|---|
| `student@devopsacademy.local` | `Student-Passw0rd` | student |
| `admin@devopsacademy.local` | `Admin-Passw0rd` | admin |

## 7. Deploying for real

Everything under `infra/` targets AWS:

- **`infra/terraform/`** — VPC (3-tier, isolated data subnets), EKS with a
  tainted lab node group, Aurora PostgreSQL Serverless v2, ElastiCache Redis,
  a private S3 bucket behind CloudFront with signed URLs, ECR, EventBridge +
  SQS, WAF, and Secrets Manager. Two environments (`staging`, `production`)
  sharing the same modules. See `infra/terraform/README.md` for the exact
  apply sequence — it costs real money to run, so don't apply it just to look
  around.
- **`infra/kubernetes/`** — Deployments/Services/HPAs/PDBs for every service,
  default-deny NetworkPolicies, least-privilege RBAC (lab-service is the only
  service with any Kubernetes API access, and it cannot read Secrets),
  External Secrets syncing from Secrets Manager, an ALB Ingress, a migration
  Job, and staging/production Kustomize overlays.
- **`.github/workflows/`** — `ci.yml` runs on every PR (lint, unit + e2e
  tests, Semgrep/Trivy/Gitleaks, a Docker build + image scan per service,
  Terraform validate). `deploy-staging.yml` runs on every push to `main`.
  `deploy-production.yml` runs on a version tag and pauses for a required
  GitHub Environment approval before touching anything, with an automatic
  rollback on a failed smoke test.

None of this is required to use the platform in Codespaces.

## 8. Known gaps (documented, not hidden)

- **Video transcoding** is not implemented; `media-service` signs whatever
  object exists at the lesson's `videoKey`. A real pipeline (MediaConvert ->
  HLS) would set `MEDIA_TRANSCODE=true` and have the upload-complete handler
  kick off a job instead of marking the asset `READY` immediately.
- **Analytics service** was scoped but not built — descoped in favour of
  finishing the services students actually touch. The event bus already
  emits everything an analytics consumer would need
  (`packages/shared/src/events.ts`), so adding it later is additive, not a
  rework.
- **Test coverage** is representative, not exhaustive: auth's token rotation
  and the payment webhook's idempotency are covered end-to-end because they
  are the two places a bug is silent and expensive; not every CRUD endpoint
  has its own e2e test.
- **Certificate export** uses the browser's own print-to-PDF on a rendered
  HTML page rather than a server-generated PDF binary, to avoid bundling a
  headless Chromium into every service image for one feature.

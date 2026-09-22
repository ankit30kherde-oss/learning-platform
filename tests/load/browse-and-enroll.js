// ---------------------------------------------------------------------------
// Runs the read-heavy path a real visitor takes: homepage, catalog, course
// detail, a preview lesson. This is deliberately the unauthenticated path -
// it is also the path that gets hit by search-engine crawlers and by anyone
// sharing a course link, so it is the load pattern most likely to spike
// without warning.
//
//   k6 run tests/load/browse-and-enroll.js
//   BASE_URL=https://staging.devopsacademy.example.com k6 run ...
// ---------------------------------------------------------------------------
import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

const errorRate = new Rate('errors');
const courseDetailDuration = new Trend('course_detail_duration');

export const options = {
  scenarios: {
    steady_browsing: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 20 },
        { duration: '2m', target: 50 },
        { duration: '1m', target: 100 }, // spike, e.g. a marketing email just went out
        { duration: '30s', target: 0 },
      ],
    },
  },
  thresholds: {
    // These are the numbers that belong in an SLO, not aspirational round
    // figures: 1% errors is already a bad day, 800ms p95 is already slow.
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<800'],
    course_detail_duration: ['p(95)<500'],
  },
};

export default function () {
  group('homepage', () => {
    const res = http.get(`${BASE_URL}/`);
    check(res, { 'homepage 200': (r) => r.status === 200 }) || errorRate.add(1);
  });

  sleep(1);

  group('catalog', () => {
    const res = http.get(`${BASE_URL}/api/courses`);
    check(res, {
      'catalog 200': (r) => r.status === 200,
      'catalog has courses': (r) => {
        try {
          const body = JSON.parse(r.body);
          return Array.isArray(body.items ?? body) && (body.items ?? body).length > 0;
        } catch {
          return false;
        }
      },
    }) || errorRate.add(1);
  });

  sleep(1);

  group('course detail', () => {
    const start = Date.now();
    const res = http.get(`${BASE_URL}/api/courses/devops-sre-engineering`);
    courseDetailDuration.add(Date.now() - start);
    check(res, { 'course detail 200': (r) => r.status === 200 }) || errorRate.add(1);
  });

  sleep(2);
}

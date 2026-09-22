import axios from 'axios';
import { AccessTokenPayload, HEADER_INTERNAL_KEY } from '@lp/shared';
import * as jwt from 'jsonwebtoken';

/**
 * The gateway resolves "may this person see this lesson?" once, so
 * course-service does not need to know about enrollments and the browser
 * cannot ask for content it has not paid for.
 */
export function decodeAccessToken(token?: string): AccessTokenPayload | null {
  if (!token) return null;
  try {
    return jwt.verify(token, process.env.JWT_ACCESS_SECRET as string, {
      issuer: process.env.JWT_ISSUER,
      audience: process.env.JWT_AUDIENCE,
    }) as AccessTokenPayload;
  } catch {
    return null;
  }
}

export async function isEntitled(userId: string, courseId: string): Promise<boolean> {
  const base = process.env.ENROLLMENT_SERVICE_URL ?? 'http://localhost:4003';
  try {
    const { data } = await axios.get(`${base}/internal/enrollments/check`, {
      params: { userId, courseId },
      headers: { [HEADER_INTERNAL_KEY]: process.env.INTERNAL_API_KEY as string },
      timeout: 3000,
    });
    return Boolean(data.entitled);
  } catch {
    // Fail CLOSED on an authorisation decision.
    return false;
  }
}

export async function courseIdForSlug(slug: string): Promise<string | null> {
  const base = process.env.COURSE_SERVICE_URL ?? 'http://localhost:4002';
  try {
    const { data } = await axios.get(`${base}/courses/${encodeURIComponent(slug)}`, {
      timeout: 3000,
    });
    return data?.id ?? null;
  } catch {
    return null;
  }
}

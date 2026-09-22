/** Roles used across every service. Keep in sync with the Prisma enums. */
export enum Role {
  STUDENT = 'STUDENT',
  INSTRUCTOR = 'INSTRUCTOR',
  ADMIN = 'ADMIN',
}

/** Shape of the signed access token. Every service decodes exactly this. */
export interface AccessTokenPayload {
  sub: string;          // user id
  email: string;
  roles: Role[];
  sid: string;          // session id (refresh family) - lets us revoke
  typ: 'access';
  iat?: number;
  exp?: number;
  iss?: string;
  aud?: string;
}

export interface RefreshTokenPayload {
  sub: string;
  sid: string;
  jti: string;          // unique id of THIS refresh token (rotation)
  typ: 'refresh';
  iat?: number;
  exp?: number;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export const HEADER_USER_ID = 'x-user-id';
export const HEADER_USER_EMAIL = 'x-user-email';
export const HEADER_USER_ROLES = 'x-user-roles';
export const HEADER_CORRELATION_ID = 'x-correlation-id';
export const HEADER_INTERNAL_KEY = 'x-internal-key';

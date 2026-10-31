export type AuthMethod = 'local' | 'm365' | 'break_glass';
export type UserStatus = 'pending_assignment' | 'active' | 'suspended' | 'disabled';

export interface SessionRow {
  id: string;
  authMethod: AuthMethod;
  csrfToken: string;
  createdAt: Date;
  lastActivityAt: Date;
  expiresAt: Date;
  stepupAt: Date | null;
  /** The database clock at the moment the session was read; every age check uses it. */
  dbNow: Date;
}

export interface UserRow {
  id: string;
  email: string;
  displayName: string;
  employeeId: string | null;
  phone: string | null;
  status: UserStatus;
  locale: string;
  theme: string;
}

/** Cached for at most 60 seconds (ADR 0002 section 5). */
export interface UserState {
  isAdmin: boolean;
  hasAssignment: boolean;
  mustChange: boolean;
  /** pending_assignment, or active without an active assignment and not a System Admin. */
  pending: boolean;
}

export interface AuthContext {
  session: SessionRow;
  user: UserRow;
  state: UserState;
  ip: string | null;
  live: boolean;
}

declare module 'express-serve-static-core' {
  interface Request {
    id?: string;
    auth?: AuthContext;
  }
}

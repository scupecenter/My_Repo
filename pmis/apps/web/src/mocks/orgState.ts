import { db } from './db';
import { initOrg } from './orgData';

/** Org state of the mock db; a db saved before contract 0.4.0 gets it on first use. */
export const O = () => (db().org ??= initOrg());

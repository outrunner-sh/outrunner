/** Readiness, by its name: the same answer as /api/health (the database
 *  probe; 503 until it's ready, and while the server drains). */
export { GET } from "../route";

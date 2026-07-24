import { auth, migrateAuthSchema } from "../src/server/auth";
import { db, migrateApplicationSchema, now } from "../src/server/db";

await migrateAuthSchema();
migrateApplicationSchema();

const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD;
const name = process.env.ADMIN_NAME?.trim() || "Administrator";

if (!email || !password || password.length < 10) {
  console.error(
    "Set ADMIN_EMAIL, ADMIN_PASSWORD (10+ characters), and optional ADMIN_NAME for this one command.",
  );
  process.exit(1);
}

const existing = db.query('SELECT id FROM "user" WHERE lower(email) = ?').get(email) as
  | { id: string }
  | null;
let userId = existing?.id;
if (!userId) {
  if (process.env.ALLOW_BOOTSTRAP_SIGNUP !== "true") {
    throw new Error("Set ALLOW_BOOTSTRAP_SIGNUP=true for first admin creation.");
  }
  const created = await auth.api.signUpEmail({
    body: { email, password, name },
    headers: new Headers({ "x-bootstrap-secret": process.env.BETTER_AUTH_SECRET ?? "" }),
  });
  userId = created.user.id;
}
db.query('UPDATE "user" SET role = ? WHERE id = ?').run("admin", userId);

const timestamp = now();
db.query(
  `INSERT INTO user_settings (user_id, monthly_quota, created_at, updated_at)
   VALUES (?, 500, ?, ?)
   ON CONFLICT(user_id) DO UPDATE SET monthly_quota = 500, updated_at = excluded.updated_at`,
).run(userId, timestamp, timestamp);

console.log(`Admin ready: ${email}`);
db.close();

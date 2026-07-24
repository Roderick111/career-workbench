import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { admin } from "better-auth/plugins/admin";
import { db } from "./db";

const production = process.env.NODE_ENV === "production";
const trustedOrigins = (process.env.APP_ORIGIN ?? "http://localhost:5173,http://localhost:3000")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

export const auth = betterAuth({
  appName: "Tailored CV",
  database: db,
  trustedOrigins,
  emailAndPassword: {
    enabled: true,
    disableSignUp: false,
    minPasswordLength: 10,
  },
  plugins: [admin()],
  session: {
    expiresIn: 60 * 60 * 24 * 14,
    updateAge: 60 * 60 * 24,
  },
  rateLimit: {
    enabled: true,
    window: 60,
    max: 100,
    storage: "database",
  },
  advanced: {
    useSecureCookies: production,
    ipAddress: {
      ipAddressHeaders: ["x-real-ip"],
    },
  },
  telemetry: {
    enabled: false,
  },
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/sign-up/email") return;
      const bootstrapSecret = ctx.headers?.get("x-bootstrap-secret");
      if (
        process.env.ALLOW_BOOTSTRAP_SIGNUP === "true" &&
        bootstrapSecret &&
        bootstrapSecret === process.env.BETTER_AUTH_SECRET
      ) {
        const users = db.query('SELECT COUNT(*) AS count FROM "user"').get() as { count: number };
        if (users.count === 0) return;
      }

      const token = ctx.headers?.get("x-invite-token");
      const claim = ctx.headers?.get("x-invite-claim");
      const email = String((ctx.body as { email?: unknown } | undefined)?.email ?? "").toLowerCase();
      if (!token || !claim || !email) throw new APIError("FORBIDDEN", { message: "Valid invite required." });
      const tokenHash = new Bun.CryptoHasher("sha256").update(token).digest("hex");
      const invite = db
        .query(
          `SELECT id FROM invites
           WHERE token_hash = ? AND email = ? AND claimed_at = ? AND expires_at > ?`,
        )
        .get(tokenHash, email, `pending:${claim}`, new Date().toISOString());
      if (!invite) throw new APIError("FORBIDDEN", { message: "Valid invite required." });
    }),
  },
});

export type AuthSession = typeof auth.$Infer.Session;

export async function migrateAuthSchema(): Promise<void> {
  const context = await auth.$context;
  await context.runMigrations();
}

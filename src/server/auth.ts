import { betterAuth } from "better-auth";
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
    disableSignUp: true,
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
});

export type AuthSession = typeof auth.$Infer.Session;

export async function migrateAuthSchema(): Promise<void> {
  const context = await auth.$context;
  await context.runMigrations();
}

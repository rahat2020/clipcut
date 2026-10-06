/**
 * Checks the user-sync and access rules (src/lib/auth/user-sync.ts) against real MongoDB,
 * without a browser or Clerk: Clerk profiles are passed in directly.
 *
 *   npm run auth:smoke
 *
 * Uses a throwaway database "<MONGODB_DB>_authtest" and drops it at the end.
 * Only example.com addresses are used. Exits with code 1 if any check fails.
 */
import { loadEnvConfig } from "@next/env";
import mongoose from "mongoose";

import { formatEnvIssues, serverEnvSchema } from "../src/lib/env.schema";
import {
  assertCanUseApp,
  findUserByClerkId,
  needsProfileSync,
  PROFILE_SYNC_INTERVAL_MS,
  syncUserFromClerk,
  type ClerkProfile,
} from "../src/lib/auth/user-sync";
import { AuditLog, configureMongoose, defaultSettings, isAppError, User, type SettingsOf } from "../src/shared";

loadEnvConfig(process.cwd());

const ADMINS = ["owner@example.com"];
const OPEN = defaultSettings("system");
const CLOSED: SettingsOf<"system"> = { ...OPEN, signupsEnabled: false };
const MAINTENANCE: SettingsOf<"system"> = { ...OPEN, maintenanceMode: true };

let seq = 0;
function profile(over: Partial<ClerkProfile> = {}): ClerkProfile {
  seq += 1;
  return {
    clerkId: `user_test_${seq}`,
    email: `person${seq}@example.com`,
    emailVerified: true,
    name: `Person ${seq}`,
    imageUrl: null,
    ...over,
  };
}

async function sync(p: ClerkProfile, system = OPEN, adminEmails = ADMINS) {
  return syncUserFromClerk(p, { adminEmails, system, existing: await findUserByClerkId(p.clerkId) });
}

async function errorCode(fn: () => unknown): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return isAppError(err) ? err.code : `non-AppError: ${String(err)}`;
  }
}

const results: { name: string; ok: boolean; detail?: string }[] = [];
async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) });
  }
}
function expect(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

async function main() {
  const parsed = serverEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("web/.env.local is invalid:\n" + formatEnvIssues(parsed.error).map((l) => `  - ${l}`).join("\n"));
    process.exit(1);
  }
  const env = parsed.data;
  const dbName = `${env.MONGODB_DB}_authtest`;

  configureMongoose();
  await mongoose.connect(env.MONGODB_URI, { dbName, serverSelectionTimeoutMS: 15_000 });
  console.log(`\nAuth smoke test · database "${dbName}"\n`);

  try {
    await mongoose.connection.dropDatabase(); // leftovers from an aborted run
    await User.createIndexes();
    await AuditLog.createIndexes();

    // ── env parsing ──────────────────────────────────────────
    await test("ADMIN_EMAILS: trims, lowercases, splits on commas", async () => {
      const r = serverEnvSchema.shape.ADMIN_EMAILS.parse(" A@Example.com, b@example.com ,");
      expect(JSON.stringify(r) === '["a@example.com","b@example.com"]', `got ${JSON.stringify(r)}`);
    });
    await test("ADMIN_EMAILS: rejects empty and non-emails", async () => {
      expect(!serverEnvSchema.shape.ADMIN_EMAILS.safeParse("").success, "empty accepted");
      expect(!serverEnvSchema.shape.ADMIN_EMAILS.safeParse("owner@example.com,nope").success, "non-email accepted");
    });

    // ── first sign-in / refresh ──────────────────────────────
    await test("first sign-in creates a user with defaults", async () => {
      const p = profile();
      const u = await sync(p);
      expect(u.role === "user" && u.status === "active" && u.plan === "free", `got ${u.role}/${u.status}/${u.plan}`);
      expect(u.email === p.email && u.lastSeenAt instanceof Date, "profile fields not stored");
      expect(u.quota?.minutesUsed === 0, "quota default missing");
    });
    await test("re-sync updates email, keeps one document", async () => {
      const p = profile();
      await sync(p);
      await sync({ ...p, email: "Changed@Example.com" });
      const docs = await User.find({ clerkId: p.clerkId }).lean();
      expect(docs.length === 1, `${docs.length} documents`);
      expect(docs[0]?.email === "changed@example.com", `email is ${docs[0]?.email}`);
    });
    await test("5 simultaneous first sign-ins → exactly one document", async () => {
      const p = profile();
      await Promise.all(Array.from({ length: 5 }, () => syncUserFromClerk(p, { adminEmails: ADMINS, system: OPEN, existing: null })));
      const n = await User.countDocuments({ clerkId: p.clerkId });
      expect(n === 1, `${n} documents`);
    });
    await test("Bangla name is stored NFC-normalised", async () => {
      const decomposed = "য়"; // য + nukta → য় (U+09DF) after NFC
      const u = await sync(profile({ name: `রাহাত ${decomposed}` }));
      expect(u.name === `রাহাত ${decomposed.normalize("NFC")}`, "name not NFC");
    });

    // ── admin bootstrap ──────────────────────────────────────
    await test("verified ADMIN_EMAILS address becomes admin + audit entry", async () => {
      const u = await sync(profile({ email: "owner@example.com" }));
      expect(u.role === "admin", `role ${u.role}`);
      const audits = await AuditLog.countDocuments({ action: "user.admin.bootstrap", "target.id": String(u._id) });
      expect(audits === 1, `${audits} audit entries`);
    });
    await test("email match is case-insensitive", async () => {
      const u = await sync(profile({ email: " OWNER@Example.COM " }), OPEN);
      expect(u.role === "admin", `role ${u.role}`);
    });
    await test("UNVERIFIED ADMIN_EMAILS address stays a normal user", async () => {
      const u = await sync(profile({ email: "owner@example.com", emailVerified: false }));
      expect(u.role === "user", `role ${u.role}`);
    });
    await test("existing user who verifies an owner email is promoted", async () => {
      const p = profile();
      await sync(p);
      const u = await sync({ ...p, email: "owner@example.com" });
      expect(u.role === "admin", `role ${u.role}`);
    });
    await test("re-sync of an admin writes no second audit entry", async () => {
      const p = profile({ email: "owner@example.com" });
      const u = await sync(p);
      await sync(p);
      const audits = await AuditLog.countDocuments({ action: "user.admin.bootstrap", "target.id": String(u._id) });
      expect(audits === 1, `${audits} audit entries`);
    });
    await test("removal from ADMIN_EMAILS never demotes", async () => {
      const p = profile({ email: "owner@example.com" });
      await sync(p);
      const u = await sync(p, OPEN, []);
      expect(u.role === "admin", `role ${u.role}`);
    });

    // ── sign-ups switch ──────────────────────────────────────
    await test("sign-ups off: new user refused and NOT stored", async () => {
      const p = profile();
      const code = await errorCode(() => sync(p, CLOSED));
      expect(code === "SIGNUPS_DISABLED", `got ${code}`);
      expect((await User.countDocuments({ clerkId: p.clerkId })) === 0, "user was inserted");
    });
    await test("sign-ups off: owner can still get in", async () => {
      const u = await sync(profile({ email: "owner@example.com" }), CLOSED);
      expect(u.role === "admin", `role ${u.role}`);
    });
    await test("sign-ups off: existing users keep working", async () => {
      const p = profile();
      await sync(p);
      const code = await errorCode(() => sync(p, CLOSED));
      expect(code === null, `got ${code}`);
    });

    // ── access rules ─────────────────────────────────────────
    await test("suspended user → ACCOUNT_SUSPENDED", async () => {
      const u = await sync(profile());
      await User.updateOne(
        { _id: u._id },
        { $set: { status: "suspended", suspension: { reason: "test", at: new Date() } } },
      );
      const fresh = await findUserByClerkId(u.clerkId);
      expect(fresh, "user vanished");
      const code = await errorCode(() => assertCanUseApp(fresh, OPEN));
      expect(code === "ACCOUNT_SUSPENDED", `got ${code}`);
    });
    await test("maintenance: users blocked, admins allowed", async () => {
      const user = await sync(profile());
      const admin = await sync(profile({ email: "owner@example.com" }));
      const userCode = await errorCode(() => assertCanUseApp(user, MAINTENANCE));
      const adminCode = await errorCode(() => assertCanUseApp(admin, MAINTENANCE));
      expect(userCode === "MAINTENANCE", `user got ${userCode}`);
      expect(adminCode === null, `admin got ${adminCode}`);
    });
    await test("active user passes", async () => {
      const code = await errorCode(async () => assertCanUseApp(await sync(profile()), OPEN));
      expect(code === null, `got ${code}`);
    });

    // ── Clerk call throttling ────────────────────────────────
    await test("profile re-sync only after 15 min", async () => {
      const u = await sync(profile());
      const now = u.lastSeenAt!.getTime();
      expect(needsProfileSync(null), "missing user should sync");
      expect(!needsProfileSync(u, new Date(now + 60_000)), "synced again after 1 min");
      expect(needsProfileSync(u, new Date(now + PROFILE_SYNC_INTERVAL_MS)), "no sync after 15 min");
    });
  } finally {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }

  for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.ok ? "" : `\n    ${r.detail}`}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed · test database "${dbName}" dropped\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

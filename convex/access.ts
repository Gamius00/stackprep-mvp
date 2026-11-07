import type { MutationCtx, QueryCtx } from "./errorTracking";
import { v } from "convex/values";
import { internalMutation, mutation, query } from "./errorTracking";
import { readRequiredEnv } from "./env";
import {
  assertMeaningfulIdentityLabel,
  normalizeIdentityEmail,
} from "../shared/identity";
import { buildUserAnalyticsIdentity, getCurrentUser } from "./users";

/** Constants for access management */
const DEMO_ACCESS_CODE = "SMARTNOTES-DEMO-2026";
export const redeemSourceValidator = v.union(
  v.literal("manual_code"),
  v.literal("magic_link"),
);

type RedeemIdentity = ReturnType<typeof buildUserAnalyticsIdentity> & {
  note?: string;
};

type RedeemFailureReason = "unknown_code" | "already_used";

export type RedeemAccessCodeTransactionResult =
  | ({
      ok: true;
      normalizedCode: string;
    } & RedeemIdentity)
  | ({
      ok: false;
      normalizedCode: string;
      reason: RedeemFailureReason;
    } & RedeemIdentity);

/** Normalizes user-entered codes for consistent lookups */
export const normalizeAccessCode = (rawCode: string) =>
  rawCode.trim().replace(/\s+/g, "-").toUpperCase();

/** Präfix, mit dem das Admin-Tool Magic-Link-Codes speichert. */
const MAGIC_LINK_CODE_PREFIX = "SMARTNOTES-";

/**
 * Sucht einen Code in allen Formen, in denen er gespeichert sein kann: in
 * Großbuchstaben, so wie getippt (ältere, von Hand angelegte Codes) und mit
 * dem Magic-Link-Präfix, falls nur die acht Zeichen eingegeben wurden.
 */
const lookupAccessCode = async (ctx: QueryCtx, rawCode: string) => {
  const normalizedCode = normalizeAccessCode(rawCode);
  const candidates = new Set([
    normalizedCode,
    rawCode.trim().replace(/\s+/g, "-"),
    ...(normalizedCode.startsWith(MAGIC_LINK_CODE_PREFIX)
      ? []
      : [MAGIC_LINK_CODE_PREFIX + normalizedCode]),
  ]);

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const accessCode = await ctx.db
      .query("accessCodes")
      .withIndex("by_normalizedCode", (q) => q.eq("normalizedCode", candidate))
      .first();
    if (accessCode) {
      return accessCode;
    }
  }
  return null;
};

const findAccessCode = async (
  ctx: MutationCtx,
  rawCode: string,
  now: number,
) => {
  const normalizedCode = normalizeAccessCode(rawCode);
  let accessCode = await lookupAccessCode(ctx, rawCode);

  if (!accessCode) {
    const existingCode = await ctx.db.query("accessCodes").first();
    if (!existingCode && normalizedCode === DEMO_ACCESS_CODE) {
      const seededId = await ctx.db.insert("accessCodes", {
        code: DEMO_ACCESS_CODE,
        normalizedCode: DEMO_ACCESS_CODE,
        createdAt: now,
        identityLabel: "Lokale Demo",
        note: "Auto-seeded demo code for local development",
      });
      accessCode = await ctx.db.get("accessCodes", seededId);
    }
  }

  return accessCode;
};

/**
 * Prüft einen Zugangscode vor der Registrierung, ohne ihn zu verbrauchen.
 * Eingelöst wird er erst nach dem Anlegen des Kontos.
 */
export const checkAccessCode = query({
  args: {
    code: v.string(),
  },
  handler: async (ctx, args) => {
    const normalizedCode = normalizeAccessCode(args.code);
    if (!normalizedCode) {
      return { status: "unknown_code" as const };
    }

    const accessCode = await lookupAccessCode(ctx, args.code);
    if (!accessCode) {
      // Der Demo-Code entsteht erst beim Einlösen, solange es keine Codes gibt.
      const isSeedableDemoCode =
        normalizedCode === DEMO_ACCESS_CODE &&
        !(await ctx.db.query("accessCodes").first());
      return {
        status: isSeedableDemoCode
          ? ("valid" as const)
          : ("unknown_code" as const),
      };
    }

    return {
      status: accessCode.consumedAt
        ? ("already_used" as const)
        : ("valid" as const),
    };
  },
});

/**
 * Schaltet das angemeldete Konto mit einem Zugangscode frei. Ein Code
 * funktioniert so oft, wie `maxRedemptions` erlaubt (standardmäßig einmal);
 * ein bereits freigeschaltetes Konto braucht keinen.
 */
export const redeemAccessCodeTransaction = internalMutation({
  args: {
    code: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) {
      throw new Error("Bitte melde dich an.");
    }

    const now = Date.now();
    const normalizedCode = normalizeAccessCode(args.code);
    const identity = buildUserAnalyticsIdentity(user);

    if (user.activatedAt) {
      return {
        ok: true,
        normalizedCode,
        ...identity,
      } satisfies RedeemAccessCodeTransactionResult;
    }

    const accessCode = await findAccessCode(ctx, args.code, now);
    if (!accessCode) {
      return {
        ok: false,
        reason: "unknown_code",
        normalizedCode,
        ...identity,
      } satisfies RedeemAccessCodeTransactionResult;
    }

    if (accessCode.consumedAt) {
      return {
        ok: false,
        reason: "already_used",
        normalizedCode: accessCode.normalizedCode,
        ...identity,
      } satisfies RedeemAccessCodeTransactionResult;
    }

    const maxRedemptions = accessCode.maxRedemptions ?? 1;
    const redemptionCount = (accessCode.redemptionCount ?? 0) + 1;
    await ctx.db.patch("accessCodes", accessCode._id, {
      redemptionCount,
      ...(redemptionCount >= maxRedemptions ? { consumedAt: now } : {}),
      // Bei Gruppencodes steht die Zuordnung nur am Konto (users.accessCodeId).
      ...(maxRedemptions === 1 ? { consumedByUserId: user._id } : {}),
    });
    await ctx.db.patch("users", user._id, {
      accessCodeId: accessCode._id,
      activatedAt: now,
      updatedAt: now,
    });

    const note = accessCode.note?.trim();
    return {
      ok: true,
      normalizedCode: accessCode.normalizedCode,
      ...identity,
      ...(note ? { note } : {}),
    } satisfies RedeemAccessCodeTransactionResult;
  },
});

/**
 * Bulk creation of access codes by an admin.
 */
export const createAccessCodes = mutation({
  args: {
    adminSecret: v.string(),
    codes: v.array(v.string()),
    identityLabel: v.string(),
    identityEmail: v.optional(v.string()),
    note: v.optional(v.string()),
    /** Wie viele Konten jeden Code einlösen dürfen; fehlt: einmal. */
    maxRedemptions: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const expectedSecret = readRequiredEnv(
      "ACCESS_CODE_ADMIN_SECRET",
      "ACCESS_CODE_ADMIN_SECRET ist nicht konfiguriert.",
    );
    if (args.adminSecret !== expectedSecret) {
      throw new Error("Ungültiges Admin-Secret.");
    }
    const { maxRedemptions } = args;
    if (
      maxRedemptions !== undefined &&
      (!Number.isInteger(maxRedemptions) || maxRedemptions < 1)
    ) {
      throw new Error("maxRedemptions muss eine ganze Zahl ab 1 sein.");
    }

    const now = Date.now();
    let inserted = 0;
    const identityLabel = assertMeaningfulIdentityLabel(args.identityLabel);
    const identityEmail = args.identityEmail
      ? normalizeIdentityEmail(args.identityEmail)
      : undefined;
    const note = args.note?.trim();

    for (const code of args.codes) {
      const normalizedCode = normalizeAccessCode(code);
      if (!normalizedCode) {
        continue;
      }

      const existing = await ctx.db
        .query("accessCodes")
        .withIndex("by_normalizedCode", (q) =>
          q.eq("normalizedCode", normalizedCode),
        )
        .first();

      if (existing) {
        continue;
      }

      await ctx.db.insert("accessCodes", {
        code,
        normalizedCode,
        createdAt: now,
        identityLabel,
        ...(maxRedemptions !== undefined && maxRedemptions > 1
          ? { maxRedemptions }
          : {}),
        ...(identityEmail ? { identityEmail } : {}),
        ...(note ? { note } : {}),
      });
      inserted += 1;
    }

    return { inserted };
  },
});

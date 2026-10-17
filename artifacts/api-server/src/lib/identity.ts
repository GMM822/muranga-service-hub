import { clerkClient, getAuth } from "@clerk/express";
import type { NextFunction, Request, Response } from "express";
import { db, usersTable } from "@workspace/db";
import type { UserRecord, UserRole } from "@workspace/db";

declare global {
  namespace Express {
    interface Request {
      appUser?: UserRecord;
    }
  }
}

function configuredAdminEmails(): Set<string> {
  return new Set(
    (process.env.ADMIN_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

export async function requireIdentity(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const { userId } = getAuth(req);
  if (!userId) {
    res.status(401).json({ error: "Sign in to continue." });
    return;
  }

  try {
    const clerkUser = await clerkClient.users.getUser(userId);
    const primaryEmail = clerkUser.primaryEmailAddress;
    const email = primaryEmail?.emailAddress?.trim().toLowerCase();
    if (!email) {
      res.status(403).json({
        error: "Add an email address to your account before continuing.",
      });
      return;
    }

    const verified = primaryEmail?.verification?.status === "verified";
    const role: UserRole =
      verified && configuredAdminEmails().has(email) ? "admin" : "citizen";
    const fullName =
      clerkUser.fullName?.trim() ||
      [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(" ") ||
      email.split("@")[0] ||
      "Resident";

    const [appUser] = await db
      .insert(usersTable)
      .values({ id: userId, email, fullName, role })
      .onConflictDoUpdate({
        target: usersTable.id,
        set: { email, fullName, role, updatedAt: new Date() },
      })
      .returning();

    req.appUser = appUser;
    next();
  } catch (error) {
    req.log.error({ err: error, userId }, "Unable to resolve signed-in user");
    next(error);
  }
}

export function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!req.appUser) {
    res.status(401).json({ error: "Sign in to continue." });
    return;
  }
  if (req.appUser.role !== "admin") {
    res.status(403).json({ error: "Administrator access is required." });
    return;
  }
  next();
}

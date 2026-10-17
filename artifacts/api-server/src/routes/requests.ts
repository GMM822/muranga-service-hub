import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import {
  CreateRequestBody,
  CreateRequestResponse,
  GetAnalyticsResponse,
  GetMyProfileResponse,
  GetRequestParams,
  GetRequestResponse,
  ListRequestsQueryParams,
  ListRequestsResponse,
  UpdateRequestStatusBody,
  UpdateRequestStatusParams,
  UpdateRequestStatusResponse,
} from "@workspace/api-zod";
import {
  db,
  requestStatusHistoryTable,
  requestUploadsTable,
  serviceRequestsTable,
} from "@workspace/db";
import type {
  RequestCategory,
  RequestStatus,
  ServiceRequestRecord,
} from "@workspace/db";
import { randomUUID } from "node:crypto";
import { requireAdmin, requireIdentity } from "../lib/identity";
import { ObjectStorageService } from "../lib/objectStorage";

const router: IRouter = Router();
const objectStorage = new ObjectStorageService();
const maxImageBytes = 5 * 1024 * 1024;
const allowedImageTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

function requestError(res: Response, message: string, status = 400): void {
  res.status(status).json({ error: message });
}

async function addHistory(
  records: ServiceRequestRecord[],
): Promise<Map<string, Array<Record<string, unknown>>>> {
  const historyByRequest = new Map<
    string,
    Array<Record<string, unknown>>
  >();
  if (records.length === 0) return historyByRequest;

  const events = await db
    .select()
    .from(requestStatusHistoryTable)
    .where(
      inArray(
        requestStatusHistoryTable.requestId,
        records.map((record) => record.id),
      ),
    )
    .orderBy(asc(requestStatusHistoryTable.createdAt));

  for (const event of events) {
    const history = historyByRequest.get(event.requestId) ?? [];
    history.push({
      id: event.id,
      status: event.status,
      note: event.note,
      createdAt: event.createdAt.toISOString(),
      updatedByName: event.actorName,
    });
    historyByRequest.set(event.requestId, history);
  }
  return historyByRequest;
}

async function serializeRequests(
  records: ServiceRequestRecord[],
): Promise<Array<Record<string, unknown>>> {
  const historyByRequest = await addHistory(records);
  return records.map((record) => ({
    id: record.id,
    trackingCode: record.trackingCode,
    category: record.category,
    location: record.location,
    description: record.description,
    status: record.status,
    imagePath: record.imagePath,
    reporterName: record.reporterName,
    reporterEmail: record.reporterEmail,
    isDemo: record.isDemo,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    history: historyByRequest.get(record.id) ?? [],
  }));
}

router.get("/me", requireIdentity, (req, res): void => {
  const user = req.appUser!;
  res.json(
    GetMyProfileResponse.parse({
      userId: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
    }),
  );
});

router.get("/requests", requireIdentity, async (req, res): Promise<void> => {
  const parsed = ListRequestsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    requestError(res, parsed.error.message);
    return;
  }

  const profile = req.appUser!;
  const { status, category, q, page = 1, pageSize = 20 } = parsed.data;
  const filters = [];
  if (profile.role !== "admin") {
    filters.push(
      eq(serviceRequestsTable.reporterUserId, profile.id),
      eq(serviceRequestsTable.isDemo, false),
    );
  }
  if (status) filters.push(eq(serviceRequestsTable.status, status));
  if (category) filters.push(eq(serviceRequestsTable.category, category));
  const search = q?.trim();
  if (search) {
    const escaped = search.replace(/[\\%_]/g, "\\$&");
    const searchFilter = or(
      ilike(serviceRequestsTable.trackingCode, `%${escaped}%`),
      ilike(serviceRequestsTable.location, `%${escaped}%`),
      ilike(serviceRequestsTable.description, `%${escaped}%`),
      ilike(serviceRequestsTable.reporterName, `%${escaped}%`),
    );
    if (searchFilter) filters.push(searchFilter);
  }
  const where = filters.length ? and(...filters) : undefined;
  const safePage = Math.max(1, page);
  const safePageSize = Math.min(100, Math.max(1, pageSize));

  const [totalResult, records] = await Promise.all([
    db
      .select({ total: count() })
      .from(serviceRequestsTable)
      .where(where),
    db
      .select()
      .from(serviceRequestsTable)
      .where(where)
      .orderBy(desc(serviceRequestsTable.createdAt))
      .limit(safePageSize)
      .offset((safePage - 1) * safePageSize),
  ]);
  const items = await serializeRequests(records);
  res.json(
    ListRequestsResponse.parse({
      items,
      total: totalResult[0]?.total ?? 0,
      page: safePage,
      pageSize: safePageSize,
    }),
  );
});

router.post("/requests", requireIdentity, async (req, res): Promise<void> => {
  const parsed = CreateRequestBody.safeParse(req.body);
  if (!parsed.success) {
    requestError(res, parsed.error.message);
    return;
  }

  const profile = req.appUser!;
  const data = parsed.data;
  const imagePath = data.imagePath?.trim() || null;
  if (imagePath) {
    const [upload] = await db
      .select()
      .from(requestUploadsTable)
      .where(
        and(
          eq(requestUploadsTable.objectPath, imagePath),
          eq(requestUploadsTable.ownerUserId, profile.id),
          isNull(requestUploadsTable.attachedRequestId),
        ),
      );
    if (!upload) {
      requestError(res, "Choose an image uploaded by this account.");
      return;
    }
    if (
      !process.env.PRIVATE_OBJECT_DIR ||
      !allowedImageTypes.has(upload.contentType)
    ) {
      res.status(503).json({
        error: "The attached image is not available in protected storage.",
      });
      return;
    }
    try {
      const file = await objectStorage.getObjectEntityFile(imagePath);
      const [metadata] = await file.getMetadata();
      const actualSize = Number(metadata.size ?? 0);
      if (
        actualSize < 1 ||
        actualSize > maxImageBytes ||
        actualSize !== upload.size
      ) {
        requestError(res, "The uploaded image is empty or larger than 5 MB.");
        return;
      }
    } catch (error) {
      req.log.warn({ err: error }, "Attached image could not be verified");
      requestError(res, "Finish uploading the image before submitting.");
      return;
    }
  }
  const id = randomUUID();
  const trackingCode = `MUR-${new Date().getFullYear()}-${id
    .replaceAll("-", "")
    .slice(0, 8)
    .toUpperCase()}`;
  const now = new Date();

  try {
    const created = await db.transaction(async (tx) => {
      if (imagePath) {
        const [upload] = await tx
          .select()
          .from(requestUploadsTable)
          .where(
            and(
              eq(requestUploadsTable.objectPath, imagePath),
              eq(requestUploadsTable.ownerUserId, profile.id),
              isNull(requestUploadsTable.attachedRequestId),
            ),
          )
          .for("update");
        if (!upload) {
          throw new Error("The attached image is not available to this account.");
        }
        await tx
          .update(requestUploadsTable)
          .set({ attachedRequestId: id })
          .where(eq(requestUploadsTable.objectPath, imagePath));
      }

      const [record] = await tx
        .insert(serviceRequestsTable)
        .values({
          id,
          trackingCode,
          category: data.category as RequestCategory,
          location: data.location.trim(),
          description: data.description.trim(),
          status: "Pending",
          imagePath,
          reporterUserId: profile.id,
          reporterName: profile.fullName,
          reporterEmail: profile.email,
          isDemo: false,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      await tx.insert(requestStatusHistoryTable).values({
        id: randomUUID(),
        requestId: record.id,
        status: "Pending",
        note: "Your request was received by Murang’a County Public Service.",
        actorUserId: profile.id,
        actorName: profile.fullName,
        isDemo: false,
        createdAt: now,
      });
      return record;
    });

    const [serialized] = await serializeRequests([created]);
    res
      .status(201)
      .json(CreateRequestResponse.parse(serialized));
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "The attached image is not available to this account."
    ) {
      requestError(res, error.message);
      return;
    }
    req.log.error({ err: error }, "Unable to create public-service request");
    res.status(500).json({ error: "Unable to submit this request right now." });
  }
});

router.get(
  "/requests/:id",
  requireIdentity,
  async (req: Request, res: Response): Promise<void> => {
    const params = GetRequestParams.safeParse(req.params);
    if (!params.success) {
      requestError(res, params.error.message);
      return;
    }
    const [record] = await db
      .select()
      .from(serviceRequestsTable)
      .where(eq(serviceRequestsTable.id, params.data.id));
    if (!record) {
      requestError(res, "Request not found.", 404);
      return;
    }
    if (
      req.appUser!.role !== "admin" &&
      (record.reporterUserId !== req.appUser!.id || record.isDemo)
    ) {
      requestError(res, "You do not have access to this request.", 403);
      return;
    }
    const [serialized] = await serializeRequests([record]);
    res.json(GetRequestResponse.parse(serialized));
  },
);

router.patch(
  "/requests/:id/status",
  requireIdentity,
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    const params = UpdateRequestStatusParams.safeParse(req.params);
    const body = UpdateRequestStatusBody.safeParse(req.body);
    if (!params.success) {
      requestError(res, params.error.message);
      return;
    }
    if (!body.success) {
      requestError(res, body.error.message);
      return;
    }

    const profile = req.appUser!;
    const result = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(serviceRequestsTable)
        .where(eq(serviceRequestsTable.id, params.data.id))
        .for("update");
      if (!existing) return null;

      const note = body.data.note?.trim() || null;
      const status = body.data.status as RequestStatus;
      const shouldAddHistory =
        status !== existing.status || Boolean(note);
      const [updated] = await tx
        .update(serviceRequestsTable)
        .set({ status, updatedAt: new Date() })
        .where(eq(serviceRequestsTable.id, params.data.id))
        .returning();

      if (shouldAddHistory) {
        await tx.insert(requestStatusHistoryTable).values({
          id: randomUUID(),
          requestId: updated.id,
          status,
          note,
          actorUserId: profile.id,
          actorName: profile.fullName,
          isDemo: existing.isDemo,
        });
      }
      return updated;
    });
    if (!result) {
      requestError(res, "Request not found.", 404);
      return;
    }
    const [serialized] = await serializeRequests([result]);
    res.json(UpdateRequestStatusResponse.parse(serialized));
  },
);

router.get(
  "/analytics",
  requireIdentity,
  requireAdmin,
  async (_req, res): Promise<void> => {
    const [totals] = await db
      .select({
        total: count(),
        pending: sql<number>`count(*) filter (where ${serviceRequestsTable.status} = 'Pending')`.mapWith(
          Number,
        ),
        inProgress: sql<number>`count(*) filter (where ${serviceRequestsTable.status} = 'In Progress')`.mapWith(
          Number,
        ),
        resolved: sql<number>`count(*) filter (where ${serviceRequestsTable.status} = 'Resolved')`.mapWith(
          Number,
        ),
        demoTotal: sql<number>`count(*) filter (where ${serviceRequestsTable.isDemo} = true)`.mapWith(
          Number,
        ),
      })
      .from(serviceRequestsTable);
    const byCategory = await db
      .select({
        category: serviceRequestsTable.category,
        count: count(),
      })
      .from(serviceRequestsTable)
      .groupBy(serviceRequestsTable.category)
      .orderBy(desc(count()));
    const data = {
      total: totals?.total ?? 0,
      open: (totals?.pending ?? 0) + (totals?.inProgress ?? 0),
      pending: totals?.pending ?? 0,
      inProgress: totals?.inProgress ?? 0,
      resolved: totals?.resolved ?? 0,
      demoTotal: totals?.demoTotal ?? 0,
      byCategory,
    };
    res.json(GetAnalyticsResponse.parse(data));
  },
);

export default router;

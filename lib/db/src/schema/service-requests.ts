import { createInsertSchema } from "drizzle-zod";
import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const requestStatusEnum = pgEnum("request_status", [
  "Pending",
  "In Progress",
  "Resolved",
]);

export const requestCategoryEnum = pgEnum("request_category", [
  "Water Supply",
  "Waste Management",
  "Roads and Transport",
  "Street Lighting",
  "Drainage and Flooding",
  "Other",
]);

export const userRoleEnum = pgEnum("user_role", ["citizen", "admin"]);

export const usersTable = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  fullName: text("full_name").notNull(),
  role: userRoleEnum("role").notNull().default("citizen"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const serviceRequestsTable = pgTable(
  "service_requests",
  {
    id: text("id").primaryKey(),
    trackingCode: text("tracking_code").notNull().unique(),
    category: requestCategoryEnum("category").notNull(),
    location: text("location").notNull(),
    description: text("description").notNull(),
    status: requestStatusEnum("status").notNull().default("Pending"),
    imagePath: text("image_path"),
    reporterUserId: text("reporter_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    reporterName: text("reporter_name").notNull(),
    reporterEmail: text("reporter_email").notNull(),
    isDemo: boolean("is_demo").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("service_requests_reporter_idx").on(table.reporterUserId),
    index("service_requests_status_created_idx").on(
      table.status,
      table.createdAt,
    ),
    index("service_requests_category_idx").on(table.category),
  ],
);

export const requestStatusHistoryTable = pgTable(
  "request_status_history",
  {
    id: text("id").primaryKey(),
    requestId: text("request_id")
      .notNull()
      .references(() => serviceRequestsTable.id, { onDelete: "cascade" }),
    status: requestStatusEnum("status").notNull(),
    note: text("note"),
    actorUserId: text("actor_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    actorName: text("actor_name").notNull(),
    isDemo: boolean("is_demo").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("request_status_history_request_idx").on(
      table.requestId,
      table.createdAt,
    ),
  ],
);

export const requestUploadsTable = pgTable(
  "request_uploads",
  {
    objectPath: text("object_path").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    originalName: text("original_name").notNull(),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    attachedRequestId: text("attached_request_id").references(
      () => serviceRequestsTable.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("request_uploads_owner_idx").on(table.ownerUserId)],
);

export const insertUserSchema = createInsertSchema(usersTable);
export const insertServiceRequestSchema = createInsertSchema(
  serviceRequestsTable,
).omit({
  createdAt: true,
  updatedAt: true,
});
export const insertRequestStatusHistorySchema = createInsertSchema(
  requestStatusHistoryTable,
).omit({ createdAt: true });
export const insertRequestUploadSchema = createInsertSchema(
  requestUploadsTable,
).omit({ createdAt: true });

export type UserRecord = typeof usersTable.$inferSelect;
export type ServiceRequestRecord = typeof serviceRequestsTable.$inferSelect;
export type RequestStatusHistoryRecord =
  typeof requestStatusHistoryTable.$inferSelect;
export type RequestStatus = ServiceRequestRecord["status"];
export type RequestCategory = ServiceRequestRecord["category"];
export type UserRole = UserRecord["role"];
export type InsertServiceRequest = z.infer<typeof insertServiceRequestSchema>;

import { pgTable, uuid, text, boolean, timestamp, integer } from 'drizzle-orm/pg-core';

export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey(), role: text('role').notNull(), displayName: text('display_name').notNull(),
  loginName: text('login_name'), passwordHash: text('password_hash'), wxOpenid: text('wx_openid'),
  mustChangePassword: boolean('must_change_password').notNull().default(false), credentialVersion: integer('credential_version').notNull().default(0),
  disabled: boolean('disabled').notNull().default(false), createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

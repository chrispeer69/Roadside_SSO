-- Roadside Mail: unified inbox across many mailboxes (IMAP/SMTP), personal or shared per tenant.

CREATE TABLE mail_accounts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  owner_user_id  uuid REFERENCES users(id) ON DELETE CASCADE,   -- NULL = shared inbox for the tenant
  shared         boolean NOT NULL DEFAULT false,
  allowed_roles  text[] NOT NULL DEFAULT '{}',                    -- shared only; empty = every member
  display_name   text NOT NULL,
  email_address  citext NOT NULL,
  provider       text NOT NULL DEFAULT 'gmail',                   -- gmail | imap
  imap_host      text NOT NULL,
  imap_port      int  NOT NULL DEFAULT 993,
  imap_secure    boolean NOT NULL DEFAULT true,
  smtp_host      text NOT NULL,
  smtp_port      int  NOT NULL DEFAULT 465,
  smtp_secure    boolean NOT NULL DEFAULT true,
  username       text NOT NULL,
  password_enc   text NOT NULL,                                   -- AES-256-GCM, see lib/mailcrypto.js
  signature      text NOT NULL DEFAULT '',
  status         text NOT NULL DEFAULT 'active',                  -- active | error | disabled
  last_sync_at   timestamptz,
  last_error     text,
  folders        jsonb NOT NULL DEFAULT '{}'::jsonb,              -- resolved mailbox paths {inbox,sent,archive,trash,drafts}
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mail_accounts_tenant_idx ON mail_accounts(tenant_id);
CREATE INDEX mail_accounts_owner_idx ON mail_accounts(owner_user_id);

-- Cached message headers (bodies are fetched live from the mailbox).
CREATE TABLE mail_messages (
  id              bigserial PRIMARY KEY,
  account_id      uuid NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  folder          text NOT NULL,                                  -- inbox | sent | archive | trash
  uid             bigint NOT NULL,
  message_id      text,
  thread_key      text,
  subject         text NOT NULL DEFAULT '',
  from_name       text NOT NULL DEFAULT '',
  from_addr       text NOT NULL DEFAULT '',
  to_addrs        text NOT NULL DEFAULT '',
  cc_addrs        text NOT NULL DEFAULT '',
  date            timestamptz NOT NULL,
  snippet         text NOT NULL DEFAULT '',
  seen            boolean NOT NULL DEFAULT false,
  flagged         boolean NOT NULL DEFAULT false,
  answered        boolean NOT NULL DEFAULT false,
  has_attachments boolean NOT NULL DEFAULT false,
  size            int NOT NULL DEFAULT 0,
  synced_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, folder, uid)
);
CREATE INDEX mail_messages_list_idx ON mail_messages(account_id, folder, date DESC);
CREATE INDEX mail_messages_unread_idx ON mail_messages(account_id, folder) WHERE NOT seen;

-- The part of Evolution API's database the desk reads (evolution_api schema, Evolution 2.3.x).
-- Used only by the tests, which run against a throwaway database.
create schema if not exists evolution_api;
set search_path to evolution_api;
do $$ begin
  create type "DeviceMessage" as enum ('ios', 'android', 'web', 'unknown', 'desktop');
exception when duplicate_object then null; end $$;
do $$ begin
  create type "InstanceConnectionStatus" as enum ('open', 'close', 'connecting');
exception when duplicate_object then null; end $$;
create table if not exists "Instance" (
  id text primary key, name varchar(255) not null unique,
  "connectionStatus" "InstanceConnectionStatus" not null default 'open',
  "ownerJid" varchar(100), "profilePicUrl" varchar(500), integration varchar(100), number varchar(100), token varchar(255),
  "clientName" varchar(100), "createdAt" timestamp default current_timestamp, "updatedAt" timestamp, "profileName" varchar(100),
  "businessId" varchar(100), "disconnectionAt" timestamp, "disconnectionObject" jsonb, "disconnectionReasonCode" integer);
create table if not exists "Message" (
  id text primary key, key jsonb not null, "pushName" varchar(100), participant varchar(100), "messageType" varchar(100) not null,
  message jsonb not null, "contextInfo" jsonb, source "DeviceMessage" not null, "messageTimestamp" integer not null,
  "chatwootMessageId" integer, "chatwootInboxId" integer, "chatwootConversationId" integer, "chatwootContactInboxSourceId" varchar(100),
  "chatwootIsRead" boolean, "instanceId" text not null references "Instance"(id) on delete cascade, "webhookUrl" varchar(500),
  "sessionId" text, status varchar(30));
create table if not exists "MessageUpdate" (
  id text primary key, "keyId" varchar(100) not null, "remoteJid" varchar(100) not null, "fromMe" boolean not null,
  participant varchar(100), "pollUpdates" jsonb, status varchar(30) not null,
  "messageId" text not null references "Message"(id) on delete cascade, "instanceId" text not null references "Instance"(id) on delete cascade);
create table if not exists "Chat" (
  id text primary key, "remoteJid" varchar(100) not null, labels jsonb, "createdAt" timestamp default current_timestamp,
  "updatedAt" timestamp, "instanceId" text not null references "Instance"(id) on delete cascade, name varchar(100),
  "unreadMessages" integer not null default 0, unique ("instanceId", "remoteJid"));
create table if not exists "Contact" (
  id text primary key, "remoteJid" varchar(100) not null, "pushName" varchar(100), "profilePicUrl" varchar(500),
  "createdAt" timestamp default current_timestamp, "updatedAt" timestamp, "instanceId" text not null references "Instance"(id) on delete cascade,
  unique ("remoteJid", "instanceId"));

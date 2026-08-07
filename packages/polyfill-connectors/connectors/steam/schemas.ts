// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { makeValidateRecord, type SchemaRegistry } from "../../src/schema-registry.ts";

const profileSchema = z.object({
  steamid: z.string(),
  personaname: z.string().nullable(),
  profileurl: z.string().nullable(),
  avatar: z.string().nullable(),
  avatarmedium: z.string().nullable(),
  avatarfull: z.string().nullable(),
  personastate: z.number().nullable(),
  communityvisibilitystate: z.number().nullable(),
  profilestate: z.number().nullable(),
  realname: z.string().nullable(),
  primaryclanid: z.string().nullable(),
  timecreated: z.number().nullable(),
  loccountrycode: z.string().nullable(),
  loccstatecode: z.string().nullable(),
  loccityid: z.string().nullable(),
  lastlogoff: z.number().nullable(),
  commentcount: z.number().nullable(),
});

const ownedGameSchema = z.object({
  id: z.string(),
  steamid: z.string(),
  appid: z.number(),
  name: z.string(),
  playtime_forever: z.number(),
  playtime_windows: z.number().nullable(),
  playtime_mac: z.number().nullable(),
  playtime_linux: z.number().nullable(),
  img_icon_url: z.string().nullable(),
  img_logo_url: z.string().nullable(),
  has_community_visible_stats: z.boolean().nullable(),
  rtime_last_played: z.number().nullable(),
  content_descriptorids: z.array(z.number()).nullable(),
});

const recentlyPlayedSchema = z.object({
  id: z.string(),
  steamid: z.string(),
  appid: z.number(),
  name: z.string(),
  playtime_2weeks: z.number().nullable(),
  playtime_forever: z.number(),
  playtime_windows: z.number().nullable(),
  playtime_mac: z.number().nullable(),
  playtime_linux: z.number().nullable(),
  img_icon_url: z.string().nullable(),
  img_logo_url: z.string().nullable(),
  rtime_last_played: z.number().nullable(),
});

const friendSchema = z.object({
  id: z.string(),
  steamid: z.string(),
  owner_steamid: z.string(),
  relationship: z.string(),
  friend_since: z.number(),
});

const steamLevelSchema = z.object({
  id: z.string(),
  steamid: z.string(),
  player_level: z.number(),
});

export const SCHEMAS: SchemaRegistry = {
  profile: profileSchema,
  owned_games: ownedGameSchema,
  recently_played_games: recentlyPlayedSchema,
  friends: friendSchema,
  steam_level: steamLevelSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);

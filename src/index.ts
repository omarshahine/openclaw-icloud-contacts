/**
 * OpenClaw plugin entry: Apple iCloud Contacts over CardDAV.
 *
 * Tools: icloud_contacts_list, icloud_contacts_search, icloud_contacts_get,
 * icloud_contacts_groups, icloud_contacts_create, icloud_contacts_update,
 * icloud_contacts_delete (write tools are not registered when readOnly).
 */

import { definePluginEntry, type OpenClawPluginDefinition } from "openclaw/plugin-sdk/plugin-entry";
import type { Static } from "@sinclair/typebox";
import { DavClient } from "./dav/client.js";
import { Session } from "./dav/discovery.js";
import { resolveConfig, type RawPluginConfig, type ResolvedConfig } from "./config.js";
import { DavError } from "./errors.js";
import { datamarkingPreamble, markContact, markGroup } from "./sanitize.js";
import { createContext, handleCreate, handleDelete, handleGet, handleGroups, handleList, handleSearch, handleUpdate, type Context } from "./tools/handlers.js";
import { createSchema, deleteSchema, getSchema, groupsSchema, listSchema, searchSchema, updateSchema } from "./tools/schemas.js";

type ListParams = Static<typeof listSchema>;
type SearchParams = Static<typeof searchSchema>;
type GetParams = Static<typeof getSchema>;
type DeleteParams = Static<typeof deleteSchema>;
type GroupsParams = Static<typeof groupsSchema>;

interface ToolResult {
  content: { type: "text"; text: string }[];
  details: Record<string, unknown> | null;
}

function ok(payload: unknown, details: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], details };
}

function fail(e: unknown, action: string): ToolResult {
  const code = e instanceof DavError ? e.code : "server_error";
  const message = e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text", text: JSON.stringify({ success: false, error: { code, message } }, null, 2) }], details: { action, errorCode: code } };
}

const pluginEntry: OpenClawPluginDefinition = definePluginEntry({
  id: "openclaw-icloud-contacts",
  name: "iCloud Contacts",
  description: "Read and write Apple iCloud Contacts over CardDAV using an Apple ID and app-specific password",

  register(api) {
    const raw = api.pluginConfig as RawPluginConfig | undefined;
    const log = api.logger;

    let ctx: Context | null = null;
    let configError: string | null = null;
    let readOnlyFromConfig = raw?.readOnly === true;

    async function getContext(): Promise<Context> {
      if (ctx) return ctx;
      if (configError) throw new DavError("not_configured", configError);
      let config: ResolvedConfig;
      try {
        config = resolveConfig(raw);
      } catch (e) {
        configError = e instanceof Error ? e.message : String(e);
        log?.warn?.(`icloud-contacts: not configured: ${configError}`);
        throw e;
      }
      readOnlyFromConfig = config.readOnly;
      const client = new DavClient({ serverUrl: config.serverUrl, username: config.appleId, password: config.appPassword });
      ctx = createContext(new Session(client), config);
      log?.info?.(`icloud-contacts: connected as ${config.appleId}${config.readOnly ? " (read-only)" : ""}`);
      return ctx;
    }

    api.registerTool({
      name: "icloud_contacts_list",
      label: "iCloud Contacts List",
      description: "List iCloud contacts (sorted by name) as brief records: id, name, organization, emails, phones, birthday, groups. Supports limit/offset paging and filtering to one group. Use icloud_contacts_search when looking for someone specific.",
      parameters: listSchema,
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const c = await getContext();
          const res = await handleList(c, params as ListParams);
          return ok({ preamble: datamarkingPreamble(), ...res, contacts: res.contacts.map(markContact) }, { action: "list", count: res.count, truncated: res.truncated });
        } catch (e) {
          return fail(e, "list");
        }
      },
    });

    api.registerTool({
      name: "icloud_contacts_search",
      label: "iCloud Contacts Search",
      description: "Search iCloud contacts by name, email, phone (digits match any formatting), organization, or any of those. Returns brief records by default; pass fields=full for complete records.",
      parameters: searchSchema,
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const c = await getContext();
          const res = await handleSearch(c, params as SearchParams);
          return ok({ preamble: datamarkingPreamble(), ...res, contacts: res.contacts.map(markContact) }, { action: "search", count: res.count, truncated: res.truncated });
        } catch (e) {
          return fail(e, "search");
        }
      },
    });

    api.registerTool({
      name: "icloud_contacts_get",
      label: "iCloud Contacts Get",
      description: "Get one iCloud contact by id with all fields (labeled emails/phones/addresses/urls, IM, relations, social profiles, dates, notes, groups, photoUrl). Set includePhoto=true to also return the photo as base64.",
      parameters: getSchema,
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const c = await getContext();
          const contact = await handleGet(c, params as GetParams);
          return ok({ preamble: datamarkingPreamble(), contact: markContact(contact) }, { action: "get", id: contact.id });
        } catch (e) {
          return fail(e, "get");
        }
      },
    });

    api.registerTool({
      name: "icloud_contacts_groups",
      label: "iCloud Contacts Groups",
      description: "Work with iCloud contact groups: list groups, list a group's members, create a group, add/remove contacts to/from a group, delete a group. Group mutations are unavailable when the plugin is read-only.",
      parameters: groupsSchema,
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const c = await getContext();
          const p = params as GroupsParams;
          if (readOnlyFromConfig && p.action !== "list" && p.action !== "members") throw new DavError("read_only", "This plugin is configured readOnly");
          const res = await handleGroups(c, p);
          const r = res as Record<string, unknown>;
          const marked = Array.isArray(r.groups) ? { ...r, groups: (r.groups as object[]).map(markGroup) } : Array.isArray(r.contacts) ? { ...r, contacts: (r.contacts as object[]).map(markContact) } : r;
          return ok({ preamble: datamarkingPreamble(), ...marked }, { action: `groups:${p.action}` });
        } catch (e) {
          return fail(e, "groups");
        }
      },
    });

    if (readOnlyFromConfig) log?.info?.("icloud-contacts: readOnly=true, write tools not registered");
    else {
      api.registerTool({
        name: "icloud_contacts_create",
        label: "iCloud Contacts Create",
        description: "Create an iCloud contact. Provide at least a name (givenName/familyName) or organization. Emails/phones/urls/addresses take {label, value} entries; labels like home, work, mobile, iPhone, main, other, or custom text.",
        parameters: createSchema,
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const c = await getContext();
            const res = await handleCreate(c, params as unknown as Parameters<typeof handleCreate>[1]);
            return ok({ success: true, contact: markContact(res.contact) }, { action: "create", id: res.contact.id });
          } catch (e) {
            return fail(e, "create");
          }
        },
      });

      api.registerTool({
        name: "icloud_contacts_update",
        label: "iCloud Contacts Update",
        description: "Update fields on an existing iCloud contact by id. Only supplied fields change; arrays (emails, phones, urls, addresses, ...) replace the whole list, so read the contact first and send the full desired list. Empty string or null clears a field.",
        parameters: updateSchema,
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const c = await getContext();
            const res = await handleUpdate(c, params as unknown as Parameters<typeof handleUpdate>[1]);
            return ok({ success: true, contact: markContact(res.contact) }, { action: "update", id: res.contact.id });
          } catch (e) {
            return fail(e, "update");
          }
        },
      });

      api.registerTool({
        name: "icloud_contacts_delete",
        label: "iCloud Contacts Delete",
        description: "Delete an iCloud contact by id. Irreversible; confirm with the user before calling.",
        parameters: deleteSchema,
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const c = await getContext();
            const res = await handleDelete(c, params as DeleteParams);
            return ok({ success: true, ...res }, { action: "delete", id: res.id });
          } catch (e) {
            return fail(e, "delete");
          }
        },
      });
    }
  },
});

export default pluginEntry;

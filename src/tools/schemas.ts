import { Type, type TSchema } from "@sinclair/typebox";

/** Optional and nullable: models frequently send null for fields they do not use. */
const OptNull = <T extends TSchema>(schema: T) => Type.Optional(Type.Union([schema, Type.Null()]));

const labeledSchema = Type.Object(
  {
    label: OptNull(Type.String({ description: "home, work, mobile, iPhone, main, other, homeFax, workFax, pager, school, or any custom text" })),
    value: Type.String(),
  },
  { additionalProperties: false },
);

const addressSchema = Type.Object(
  {
    label: OptNull(Type.String({ description: "home, work, other, or custom" })),
    street: OptNull(Type.String()),
    city: OptNull(Type.String()),
    state: OptNull(Type.String()),
    postalCode: OptNull(Type.String()),
    country: OptNull(Type.String()),
    countryCode: OptNull(Type.String({ description: "ISO 3166-1 alpha-2, e.g. us" })),
  },
  { additionalProperties: false },
);

const dateSchema = Type.Object(
  {
    label: OptNull(Type.String({ description: "anniversary, other, or custom" })),
    year: OptNull(Type.Integer()),
    month: Type.Integer({ minimum: 1, maximum: 12 }),
    day: Type.Integer({ minimum: 1, maximum: 31 }),
  },
  { additionalProperties: false },
);

const birthdaySchema = Type.Object(
  { year: OptNull(Type.Integer()), month: Type.Integer({ minimum: 1, maximum: 12 }), day: Type.Integer({ minimum: 1, maximum: 31 }) },
  { additionalProperties: false },
);

const imSchema = Type.Object(
  { label: OptNull(Type.String()), service: Type.String({ description: "e.g. Skype, WhatsApp, Signal, Telegram, Jabber" }), username: Type.String() },
  { additionalProperties: false },
);

const relationSchema = Type.Object(
  { label: Type.String({ description: "mother, father, parent, brother, sister, child, friend, spouse, partner, assistant, manager, or custom" }), name: Type.String() },
  { additionalProperties: false },
);

const socialSchema = Type.Object(
  {
    label: OptNull(Type.String()),
    service: Type.String({ description: "twitter, facebook, linkedin, instagram, github, mastodon, ..." }),
    username: OptNull(Type.String()),
    url: OptNull(Type.String()),
  },
  { additionalProperties: false },
);

const writableFields = {
  givenName: OptNull(Type.String()),
  familyName: OptNull(Type.String()),
  middleName: OptNull(Type.String()),
  namePrefix: OptNull(Type.String({ description: "e.g. Dr., Mr." })),
  nameSuffix: OptNull(Type.String({ description: "e.g. Jr., PhD" })),
  nickname: OptNull(Type.String()),
  phoneticGivenName: OptNull(Type.String()),
  phoneticFamilyName: OptNull(Type.String()),
  organization: OptNull(Type.String()),
  department: OptNull(Type.String()),
  jobTitle: OptNull(Type.String()),
  contactType: OptNull(Type.Union([Type.Literal("person"), Type.Literal("organization")])),
  emails: OptNull(Type.Array(labeledSchema, { description: "Replaces all emails on update. Empty array or null clears." })),
  phones: OptNull(Type.Array(labeledSchema, { description: "Replaces all phones on update." })),
  urls: OptNull(Type.Array(labeledSchema, { description: "Replaces all URLs on update." })),
  addresses: OptNull(Type.Array(addressSchema, { description: "Replaces all postal addresses on update." })),
  instantMessages: OptNull(Type.Array(imSchema)),
  relations: OptNull(Type.Array(relationSchema)),
  socialProfiles: OptNull(Type.Array(socialSchema)),
  birthday: OptNull(birthdaySchema),
  dates: OptNull(Type.Array(dateSchema)),
  notes: OptNull(Type.String({ description: "Empty string or null clears on update." })),
};

export const listSchema = Type.Object(
  {
    limit: OptNull(Type.Integer({ minimum: 1, maximum: 500, description: "Max contacts to return (default from config, 25)" })),
    offset: OptNull(Type.Integer({ minimum: 0, description: "Skip this many (for paging)" })),
    group: OptNull(Type.String({ description: "Only members of this group (name or id)" })),
    fields: OptNull(Type.Union([Type.Literal("brief"), Type.Literal("full")], { description: "brief (default) or full contact records" })),
  },
  { additionalProperties: false },
);

export const searchSchema = Type.Object(
  {
    query: Type.String({ description: "Text to match. Phones match by digits (any formatting)." }),
    field: OptNull(Type.Union([Type.Literal("name"), Type.Literal("email"), Type.Literal("phone"), Type.Literal("org"), Type.Literal("any")], { description: "Where to match (default any)" })),
    limit: OptNull(Type.Integer({ minimum: 1, maximum: 500 })),
    group: OptNull(Type.String({ description: "Only members of this group (name or id)" })),
    fields: OptNull(Type.Union([Type.Literal("brief"), Type.Literal("full")])),
  },
  { additionalProperties: false },
);

export const getSchema = Type.Object(
  {
    id: Type.String({ description: "Contact id (vCard UID) from list/search" }),
    includePhoto: OptNull(Type.Boolean({ description: "Fetch the photo and include it as base64 (large). Default false; photoUrl is always returned when present." })),
  },
  { additionalProperties: false },
);

export const createSchema = Type.Object({ ...writableFields }, { additionalProperties: false });

export const updateSchema = Type.Object({ id: Type.String({ description: "Contact id (vCard UID)" }), ...writableFields }, { additionalProperties: false });

export const deleteSchema = Type.Object({ id: Type.String({ description: "Contact id (vCard UID) to delete" }) }, { additionalProperties: false });

export const groupsSchema = Type.Object(
  {
    action: Type.Union([Type.Literal("list"), Type.Literal("members"), Type.Literal("create"), Type.Literal("add"), Type.Literal("remove"), Type.Literal("delete")], {
      description: "list groups; members of a group; create a group; add/remove contact ids to/from a group; delete an (empty or non-empty) group",
    }),
    group: OptNull(Type.String({ description: "Group name or id (required except for list/create)" })),
    name: OptNull(Type.String({ description: "New group name (create)" })),
    contactIds: OptNull(Type.Array(Type.String(), { description: "Contact ids for add/remove" })),
    limit: OptNull(Type.Integer({ minimum: 1, maximum: 500 })),
  },
  { additionalProperties: false },
);

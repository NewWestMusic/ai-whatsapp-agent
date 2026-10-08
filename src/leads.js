// Writes WhatsApp leads into the "WhatsApp Leads" table of the
// "Facebook Lead Forms Tracker" Airtable base (kept separate from the
// Facebook leads). Field IDs are used instead of names so renaming a column
// in Airtable doesn't break the bot.

const DEFAULT_BASE_ID = "appMB0fLLfFzT0Ult";
const DEFAULT_TABLE_ID = "tblAmIvm7gPQEr3sM";

const FIELDS = {
  name: "fldHxHn9LLjNjEdrm",
  phone: "fldypKCZnQueKyjqB",
  studentName: "fldQlST5nJEL33cEb",
  studentAge: "fld0xIHIUxOdVqMuI",
  email: "fldKxroSaf5x1SP0X",
  instruments: "fldHwPelP83N0dktb",
  preferredTimes: "fldAWvudRdWyr7ygf",
  location: "fldywYVHcpv3bvoiy",
  bookingPath: "fldispjtXK2WB3bSw",
  status: "fldBqgCtF21q4vKnU",
  needsFollowUp: "fldzfBhN5xgcj6FTG",
  followUpReason: "fldYe7r9FjEzPhPG4",
  notes: "fldy9nAWuffhRw0p3",
  firstContact: "fld2urjOBzEjMBwFG",
  lastUpdated: "fldT6D7rZcVDFowZ9",
};

// Must match the "Instrument Requested" options in Airtable exactly.
export const INSTRUMENT_OPTIONS = [
  "Piano", "Guitar", "Voice", "Drums", "Ukulele", "Violin", "Bass Guitar",
  "Flute", "Clarinet", "Saxophone", "123 (Preschool Piano)", "Choir", "Adult Group Guitar",
];

export class AirtableLeads {
  constructor({
    token = process.env.AIRTABLE_TOKEN,
    baseId = process.env.AIRTABLE_BASE_ID || DEFAULT_BASE_ID,
    tableId = process.env.AIRTABLE_LEADS_TABLE_ID || DEFAULT_TABLE_ID,
    fetchFn = fetch,
  } = {}) {
    this.token = token;
    this.url = `https://api.airtable.com/v0/${baseId}/${tableId}`;
    this.fetch = fetchFn;
  }

  get enabled() {
    return Boolean(this.token);
  }

  /**
   * Create the lead, or update it if this customer already has one.
   * @returns {Promise<string>} the Airtable record id
   */
  async upsert(existingId, lead) {
    const fields = toFields(lead, { isNew: !existingId });
    const res = await this.fetch(existingId ? `${this.url}/${existingId}` : this.url, {
      method: existingId ? "PATCH" : "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields }),
    });
    if (!res.ok) {
      throw new Error(`Airtable ${res.status}: ${(await res.text()).slice(0, 500)}`);
    }
    return (await res.json()).id;
  }
}

function toFields(lead, { isNew, now = new Date().toISOString() }) {
  // Only fields the bot actually knows are sent, so a later update never
  // blanks out something learned earlier or edited by staff.
  const fields = { [FIELDS.lastUpdated]: now };
  if (isNew) fields[FIELDS.firstContact] = now;
  const set = (key, value) => {
    if (value !== undefined && value !== null && value !== "") fields[FIELDS[key]] = value;
  };
  set("phone", lead.phone);
  set("name", lead.parent_name);
  set("studentName", lead.student_name);
  if (Number.isFinite(lead.student_age)) set("studentAge", lead.student_age);
  set("email", lead.email);
  const instruments = (lead.instruments ?? []).filter((i) => INSTRUMENT_OPTIONS.includes(i));
  if (instruments.length) set("instruments", instruments);
  set("preferredTimes", lead.preferred_times);
  set("location", lead.location);
  set("bookingPath", lead.booking_path);
  set("status", lead.status);
  set("notes", lead.notes);
  if (lead.follow_up_reason) {
    fields[FIELDS.needsFollowUp] = true;
    fields[FIELDS.followUpReason] = lead.follow_up_reason;
  }
  return fields;
}

export { toFields as _toFieldsForTests };

// Shared types for the iCal connector. Kept out of index.ts so the pure
// parsers in parsers.ts can import them without pulling in the runtime
// entry point or fetch/fs wiring.

export interface IcsAttendee {
  email: string;
  name: string | null;
  role: string | null;
}

export interface IcsEvent {
  all_day?: boolean;
  attendees: IcsAttendee[];
  calendar_name: string;
  description?: string;
  end?: string | null;
  location?: string;
  organizer_email?: string;
  rrule?: string;
  start?: string | null;
  status?: string;
  summary?: string;
  uid?: string;
}

export interface IcsSource {
  name: string;
  text: string;
}

export interface IcalState {
  events?: { latest_start?: string };
}

/** One parsed key/value line from inside a VEVENT block. */
export interface IcsLine {
  isDateOnly: boolean;
  name: string;
  params: Record<string, string | undefined>;
  value: string;
}

/** Shape emitted on the `events` stream. */
export interface IcsEventOut {
  all_day: boolean;
  attendees: IcsAttendee[];
  calendar_name: string;
  description: string | null;
  end: string | null;
  id: string;
  location: string | null;
  organizer_email: string | null;
  rrule: string | null;
  start: string;
  status: string | null;
  summary: string | null;
  uid: string;
}

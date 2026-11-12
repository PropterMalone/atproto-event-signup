import { randomBytes } from "node:crypto";
import type { Attendance } from "../shared/types.js";

export const RSVP_COLLECTION = "community.lexicon.calendar.rsvp";
export const RSVP_SCOPE = `repo:${RSVP_COLLECTION}`;
export interface EventReference {
	uri: string;
	cid: string;
}
export interface PublicRsvp {
	$type: string;
	subject: EventReference;
	status: string;
}
export interface Publication {
	rkey: string;
	event: EventReference;
	status: "published" | "withdrawn" | "uncertain" | "reauthorize" | "conflict";
	// Retain both possible values across a lost response; never adopt an unrelated record.
	records: PublicRsvp[];
	// Once a put loses its acknowledgement, absence cannot rule out a later commit.
	unresolvedPut?: boolean;
}
export type PublicationResult =
	| { ok: true }
	| { ok: false; reason: "reauthorize" | "uncertain" | "conflict" };
export function publicRsvp(
	event: EventReference,
	attendance: Exclude<Attendance, null>,
): PublicRsvp {
	const status = { coming: "going", maybe: "interested", cant: "notgoing" }[attendance];
	return { $type: RSVP_COLLECTION, subject: event, status: `${RSVP_COLLECTION}#${status}` };
}
export function ownedTid(): string {
	const alphabet = "234567abcdefghijklmnopqrstuvwxyz";
	let value =
		((BigInt(Date.now()) * 1000n) << 10n) | (BigInt(randomBytes(2).readUInt16BE()) & 1023n);
	let result = "";
	for (let i = 0; i < 13; i++) {
		result = alphabet[Number(value & 31n)] + result;
		value >>= 5n;
	}
	return result;
}

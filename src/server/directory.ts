import type { DirectoryEntry, SavedResponse } from "../shared/types.js";
import { storedVisibility } from "../shared/visibility.js";

export interface Relationship {
	viewerFollowsOwner: boolean;
	ownerFollowsViewer: boolean;
}
export type RelationshipLookup = (
	viewerDid: string,
	ownerDid: string,
) => Promise<Relationship | null>;
type RelationshipBatchLookup = (
	viewerDid: string,
	ownerDids: string[],
) => Promise<Map<string, Relationship> | null>;
interface AttendanceDirectoryResult {
	entries: DirectoryEntry[];
	incomplete: boolean;
}

export async function attendanceDirectory(
	rows: SavedResponse[],
	viewerDid: string | null,
	lookup?: RelationshipLookup,
	batchLookup?: RelationshipBatchLookup,
): Promise<AttendanceDirectoryResult> {
	const active = rows.filter((row) => row.attendance === "coming" || row.attendance === "maybe");
	const gated = active.filter((row) => {
		const audience = storedVisibility(row.visibility);
		return (
			!!viewerDid &&
			row.did !== viewerDid &&
			["followers", "following", "either", "mutuals"].includes(audience)
		);
	});
	const relationships = new Map<string, Relationship>();
	let incomplete = false;
	if (gated.length && batchLookup) {
		const deadline = Date.now() + 10000;
		const batches: string[][] = [];
		for (let index = 0; index < Math.min(gated.length, 200); index += 30)
			batches.push(gated.slice(index, Math.min(index + 30, 200)).map((row) => row.did));
		for (let offset = 0; offset < batches.length; offset += 4) {
			if (Date.now() >= deadline) break;
			const results = await Promise.all(
				batches.slice(offset, offset + 4).map(async (owners) => {
					let timer: ReturnType<typeof setTimeout> | undefined;
					try {
						return await Promise.race([
							batchLookup(viewerDid!, owners),
							new Promise<null>((resolve) => {
								timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()));
							}),
						]);
					} catch {
						return null;
					} finally {
						if (timer) clearTimeout(timer);
					}
				}),
			);
			for (const result of results)
				if (result)
					for (const [did, relation] of result)
						if (
							relation &&
							typeof relation.viewerFollowsOwner === "boolean" &&
							typeof relation.ownerFollowsViewer === "boolean"
						)
							relationships.set(did, relation);
		}
		if (gated.length > 200 || gated.slice(0, 200).some((row) => !relationships.has(row.did)))
			incomplete = true;
	} else if (gated.length && lookup) {
		for (const row of gated.slice(0, 30)) {
			try {
				const relation = await lookup(viewerDid!, row.did);
				if (
					relation &&
					typeof relation.viewerFollowsOwner === "boolean" &&
					typeof relation.ownerFollowsViewer === "boolean"
				)
					relationships.set(row.did, relation);
			} catch {
				/* unknown relationship evidence denies access */
			}
		}
		if (gated.length > 30 || gated.some((row) => !relationships.has(row.did))) incomplete = true;
	} else if (gated.length) incomplete = true;

	const entries: DirectoryEntry[] = [];
	for (const row of active) {
		const audience = storedVisibility(row.visibility);
		let visible =
			audience === "public" || (!!viewerDid && (row.did === viewerDid || audience === "loggedin"));
		if (
			!visible &&
			viewerDid &&
			["followers", "following", "either", "mutuals"].includes(audience)
		) {
			const relation = relationships.get(row.did);
			if (
				relation &&
				typeof relation.viewerFollowsOwner === "boolean" &&
				typeof relation.ownerFollowsViewer === "boolean"
			) {
				const { viewerFollowsOwner: follower, ownerFollowsViewer: following } = relation;
				visible =
					audience === "followers"
						? follower
						: audience === "following"
							? following
							: audience === "either"
								? follower || following
								: follower && following;
			}
		}
		if (visible && (row.attendance === "coming" || row.attendance === "maybe"))
			entries.push({ did: row.did, handle: row.handle, attendance: row.attendance });
	}
	return { entries, incomplete };
}

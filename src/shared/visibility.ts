export const visibilityLabels = {
	private: "Private — only me and organizers",
	loggedin: "Anyone signed in",
	public: "Everyone, including signed-out visitors",
	followers: "People who follow me",
	following: "People I follow",
	either: "People I follow or who follow me",
	mutuals: "People I follow who also follow me",
} as const;
export type AttendanceVisibility = keyof typeof visibilityLabels;
export function isVisibility(value: unknown): value is AttendanceVisibility {
	return typeof value === "string" && Object.hasOwn(visibilityLabels, value);
}
export function storedVisibility(value: unknown): AttendanceVisibility {
	return isVisibility(value) ? value : "private";
}

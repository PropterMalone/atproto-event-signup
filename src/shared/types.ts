export type Attendance = "coming" | "maybe" | "cant" | null;
export type ButtonStyle = "handle" | "pfp" | null;
export type TextPosition = "top" | "bottom";
export type TextColor = "white" | "black";
export interface Profile {
	did: string;
	handle: string;
	avatar: string | null;
}
export interface ResponseInput {
	attendance: Attendance;
	button: ButtonStyle;
	replaceArtwork?: boolean;
	label?: string;
	position?: TextPosition;
	color?: TextColor;
	futureMeetups?: boolean;
}
export interface FutureContact {
	did: string;
	handle: string;
	optedAt: number;
}
export interface Artwork {
	avatar: string;
	handle: string;
	style: Exclude<ButtonStyle, null>;
	approvedAt: number;
	label?: string;
	rendererVersion?: number;
	position?: TextPosition;
	color?: TextColor;
}
export interface SavedResponse {
	did: string;
	handle: string;
	attendance: Attendance;
	artwork: Artwork | null;
	updatedAt: number;
}
export interface Session {
	profile: Profile;
	csrf: string;
	expires: number;
}
export interface ClientState {
	profile: Profile | null;
	csrf: string;
	response: SavedResponse | null;
	responseVersion: string;
	futureMeetups: boolean;
	preview: { profile: string; saved: string | null };
	admin: boolean;
	policy: {
		responseCutoff: number | null;
		buttonCutoff: number | null;
		artworkDeleteAt: number | null;
	};
}

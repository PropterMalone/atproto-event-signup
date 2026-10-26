import type { TextColor, TextPosition } from "./types.js";

export const BUTTON_RENDERER_VERSION = 3;
export const BUTTON_FACE_MM = 58;
export const BUTTON_LABEL_GUIDANCE =
	"Use a shorter name on your button (up to 40 characters). Your full verified handle stays on your account.";

export function defaultButtonLabel(handle: string): string {
	return `@${handle.replace(/^@/, "").replace(/\.bsky\.social$/i, "")}`;
}
export function normalizeButtonLabel(value: string): string | null {
	if (
		value.length > 160 ||
		/[\p{Cc}\p{Cs}\p{Zl}\p{Zp}\u061c\u200b\u200e\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(
			value,
		)
	)
		return null;
	const label = value
		.normalize("NFC")
		.trim()
		.replace(/\p{Zs}+/gu, " ");
	const characters = [...label];
	// Retain the conservative width budget; never squeeze text to fit.
	const width = characters.reduce(
		(sum, c) =>
			sum +
			(/\p{M}|\u200d|\ufe0f/u.test(c)
				? 0
				: /[ilI.,'!| ]/.test(c)
					? 0.35
					: /[MW@]/u.test(c) || (c.codePointAt(0) ?? 0) > 0x024f
						? 1
						: 0.65),
		0,
	);
	return characters.length > 0 && characters.length <= 40 && width <= 21 ? label : null;
}
export function buttonApproval(
	source: string,
	style: string,
	label: string,
	position: TextPosition = "bottom",
	color: TextColor = "white",
): string {
	return JSON.stringify([
		BUTTON_RENDERER_VERSION,
		source,
		style,
		style === "handle" ? label : null,
		position,
		color,
	]);
}
export function escapeXml(value: string): string {
	return value.replace(
		/[&<>"']/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? "",
	);
}
export function renderButton(
	art: {
		avatar: string;
		style: "handle" | "pfp";
		label: string;
		position?: TextPosition;
		color?: TextColor;
		rendererVersion?: number;
	},
	id: string,
): string {
	if (!/^[a-zA-Z][\w-]*$/.test(id)) throw Error("Invalid button id");
	const avatar = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(art.avatar)
		? art.avatar
		: "";
	const label = art.style === "handle" ? normalizeButtonLabel(art.label) : null;
	if (art.style === "handle" && !label) throw Error(BUTTON_LABEL_GUIDANCE);
	const legacy = art.rendererVersion === 1;
	if (
		art.rendererVersion !== undefined &&
		!legacy &&
		art.rendererVersion !== 2 &&
		art.rendererVersion !== BUTTON_RENDERER_VERSION
	)
		throw Error("Unsupported button design; edit and save to approve the current preview.");
	const arc = legacy
		? "M 7.5 29 A 21.5 21.5 0 0 0 50.5 29"
		: `M 4.5 29 A 24.5 24.5 0 0 ${art.position === "top" ? 1 : 0} 53.5 29`;
	const typography = legacy
		? 'font-family="Arial, sans-serif" font-size="3.4" font-weight="bold"'
		: 'font-family="system-ui, sans-serif" font-size="3.2" font-weight="600"';
	const black = !legacy && art.rendererVersion !== 2 && art.color === "black";
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 58 58" role="img" aria-label="Button preview" data-renderer="${art.rendererVersion ?? BUTTON_RENDERER_VERSION}"><defs><clipPath id="${id}-clip"><circle cx="29" cy="29" r="29"/></clipPath><path id="${id}-arc" d="${arc}"/></defs><g clip-path="url(#${id}-clip)"><circle cx="29" cy="29" r="29" fill="#ddd"/>${avatar ? `<image href="${avatar}" width="58" height="58" preserveAspectRatio="xMidYMid slice"/>` : ""}${label ? `<text ${typography} text-anchor="middle" fill="${black ? "black" : "white"}" stroke="${black ? "white" : "black"}" stroke-width="${legacy ? 0.9 : 0.3}" paint-order="stroke fill" stroke-linejoin="round" stroke-linecap="round"><textPath href="#${id}-arc" startOffset="50%">${escapeXml(label)}</textPath></text>` : ""}</g></svg>`;
}

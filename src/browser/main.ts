import {
	BUTTON_LABEL_GUIDANCE,
	BUTTON_RENDERER_VERSION,
	buttonApproval,
	defaultButtonLabel,
	normalizeButtonLabel,
	renderButton,
} from "../shared/button.js";
import { loginHandle } from "../shared/handle.js";
import type {
	Attendance,
	ButtonStyle,
	ClientState,
	DirectoryEntry,
	TextColor,
	TextPosition,
} from "../shared/types.js";
import {
	type AttendanceVisibility,
	storedVisibility,
	visibilityLabels,
} from "../shared/visibility.js";

function element<T extends HTMLElement>(id: string): T {
	const el = document.getElementById(id);
	if (!el) throw Error(`Missing ${id}`);
	return el as T;
}
const status = element("status");
let state: ClientState;
let artworkEdited = false;
let loadGeneration = 0;
let accountGeneration = 0;
async function api(path: string, method = "GET", body?: unknown) {
	const response = await fetch(path, {
		method,
		headers: {
			accept: "application/json",
			"content-type": "application/json",
			"x-csrf-token": state?.csrf ?? "",
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	const data = await response.json();
	if (!response.ok) throw Error(data.error ?? "Request failed");
	return data;
}
function message(error: unknown) {
	status.textContent = error instanceof Error ? error.message : "Request failed";
}
function selectedAttendance(): Attendance {
	return ([...document.querySelectorAll<HTMLInputElement>('input[name="attendance"]')].find(
		(input) => input.checked,
	)?.value || null) as Attendance;
}
function preview() {
	const selected = selectedAttendance();
	const opt = element<HTMLInputElement>("button-opt-in");
	opt.disabled = selected === "cant";
	if (opt.disabled) opt.checked = false;
	const replacement = element<HTMLInputElement>("replace-artwork").checked;
	const artwork = state.response?.artwork;
	element("button-design").hidden = !opt.checked;
	element("replacement-option").hidden = !artwork;
	const source = artwork && !replacement ? artwork : state.profile;
	const image = source?.avatar;
	element("preview").hidden = !opt.checked || !image;
	const style = element<HTMLSelectElement>("style").value as "handle" | "pfp";
	const input = element<HTMLInputElement>("button-label");
	element("label-option").hidden = style === "pfp";
	element("position-option").hidden = style === "pfp";
	element("color-option").hidden = style === "pfp";
	const position = element<HTMLSelectElement>("text-position").value as TextPosition;
	const color = element<HTMLSelectElement>("text-color").value as TextColor;
	const savedVersion =
		artwork && !artworkEdited && !replacement ? artwork.rendererVersion : undefined;
	const label = normalizeButtonLabel(input.value);
	input.setCustomValidity(opt.checked && style === "handle" && !label ? BUTTON_LABEL_GUIDANCE : "");
	element("preview").innerHTML =
		image && (style === "pfp" || label)
			? renderButton(
					{
						avatar: image,
						style,
						label: label ?? "",
						position,
						color,
						...(savedVersion === undefined ? {} : { rendererVersion: savedVersion }),
					},
					"preview",
				)
			: "";
	element("artwork-note").textContent =
		opt.checked && style === "handle" && !label
			? BUTTON_LABEL_GUIDANCE
			: opt.checked && image && artwork && artworkEdited
				? "Save to approve this updated button preview for printing."
				: opt.checked && image && artwork && artwork.rendererVersion !== BUTTON_RENDERER_VERSION
					? "This older request needs a fresh design approval. Change a button option and save to approve the updated preview for printing."
					: !opt.checked || image
						? ""
						: "No profile picture available. You can still save your attendance.";
}
const visibilitySelect = element<HTMLSelectElement>("visibility");
for (const [value, label] of Object.entries(visibilityLabels)) {
	const option = document.createElement("option");
	option.value = value;
	option.textContent = label;
	visibilitySelect.append(option);
}
async function loadDirectory(generation: number) {
	const list = element("directory");
	list.replaceChildren();
	element("directory-status").textContent = "Loading shared attendance…";
	try {
		const data = await api("/api/directory");
		if (generation !== loadGeneration) return;
		for (const entry of (data.entries ?? []) as DirectoryEntry[]) {
			const li = document.createElement("li");
			const link = document.createElement("a");
			link.href = `https://bsky.app/profile/${encodeURIComponent(entry.did)}`;
			link.textContent = `@${entry.handle}`;
			link.rel = "noopener noreferrer";
			li.append(link, ` — ${entry.attendance === "coming" ? "Coming" : "Maybe"}`);
			list.append(li);
		}
		element("directory-status").textContent = data.incomplete
			? list.children.length
				? "Some shared attendance could not be checked. Showing only entries confirmed visible to you."
				: "Some shared attendance could not be checked. No entries could be confirmed visible to you."
			: list.children.length
				? ""
				: "No attendance shared with you yet.";
	} catch {
		if (generation === loadGeneration)
			element("directory-status").textContent = "Shared attendance is temporarily unavailable.";
	}
}
function savedSummary() {
	const share = element<HTMLAnchorElement>("share-attendance");
	const canShare = !!state.profile && state.response?.attendance === "coming";
	share.hidden = !canShare;
	element("share-help").hidden = !canShare;
	if (canShare) {
		const url = new URL("https://bsky.app/intent/compose");
		url.searchParams.set(
			"text",
			`I’m coming to this meetup! ${state.share?.url ?? location.origin + "/"}`,
		);
		share.href = url.toString();
	} else share.removeAttribute("href");
	const attendance = state.response?.attendance;
	const button = !!state.response?.artwork;
	const future = state.futureMeetups;
	const saved = !!state.profile && (!!attendance || button || future);
	element("saved-summary").hidden = !saved;
	if (!saved) {
		element("saved-heading").textContent = "";
		element("saved-choices").textContent = "";
		return;
	}
	element("saved-heading").textContent =
		attendance === "coming"
			? "You’re signed up"
			: attendance
				? "Your response is saved"
				: button
					? "Your button request is saved"
					: "You’re on the list for future meetups";
	const choice =
		attendance === "coming"
			? "Coming"
			: attendance === "maybe"
				? "Maybe"
				: attendance === "cant"
					? "Not this time"
					: "Not answered";
	element("saved-choices").textContent =
		`Attendance: ${choice}. Visibility: ${visibilityLabels[storedVisibility(state.response?.visibility)]}. Button: ${button ? "Requested" : "Not requested"}. Future meetups: ${future ? "On the list" : "Not on the list"}.`;
}
async function load() {
	const generation = ++loadGeneration;
	const nextState = (await api("/api/me")) as ClientState;
	if (generation !== loadGeneration) return;
	state = nextState;
	savedSummary();
	visibilitySelect.value = storedVisibility(state.response?.visibility);
	element<HTMLButtonElement>("save-visibility").disabled = !state.response;
	await loadDirectory(generation);
	if (generation !== loadGeneration) return;
	artworkEdited = false;
	element("signed-out").hidden = !!state.profile;
	element("signed-in").hidden = !state.profile;
	element("operator").hidden = !state.admin;
	if (state.profile) {
		element("identity").textContent = `Signed in as @${state.profile.handle}`;
		const value = state.response?.attendance ?? "";
		for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="attendance"]'))
			radio.checked = radio.value === value;
		element<HTMLInputElement>("button-opt-in").checked = !!state.response?.artwork;
		element<HTMLInputElement>("future-meetups").checked = state.futureMeetups;
		element<HTMLSelectElement>("style").value = state.response?.artwork?.style ?? "handle";
		element<HTMLInputElement>("replace-artwork").checked = false;
		element<HTMLSelectElement>("text-position").value =
			state.response?.artwork?.position ?? "bottom";
		element<HTMLSelectElement>("text-color").value = state.response?.artwork?.color ?? "white";
		element<HTMLInputElement>("button-label").value =
			state.response?.artwork?.label ??
			defaultButtonLabel(state.response?.artwork?.handle ?? state.profile.handle);
		preview();
	}
	const date = (value: number) =>
		new Date(value).toLocaleString("en-US", {
			timeZone: "America/New_York",
			timeZoneName: "short",
		});
	const deadlines: string[] = [];
	if (state.policy.buttonCutoff !== null)
		deadlines.push(`Request or change buttons by ${date(state.policy.buttonCutoff)}.`);
	if (state.policy.responseCutoff !== null)
		deadlines.push(`Update attendance by ${date(state.policy.responseCutoff)}.`);
	if (state.policy.artworkDeleteAt !== null)
		deadlines.push(`Stored artwork deleted ${date(state.policy.artworkDeleteAt)}.`);
	element("policy").textContent = deadlines.join(" ");
	element("policy").hidden = deadlines.length === 0;
	if (state.admin) {
		const admin = await api("/api/admin");
		if (generation !== loadGeneration) return;
		const c = admin.counts;
		element("counts").textContent =
			`Coming: ${c.coming} · Maybe: ${c.maybe} · Not this time: ${c.cant} · Button requests: ${c.buttons} · Future meetups: ${c.futureMeetups}`;
		const { contacts } = await api("/api/admin/futurecontacts");
		if (generation !== loadGeneration) return;
		const renderContacts = () => {
			if (generation !== loadGeneration) return;
			const query = element<HTMLInputElement>("contact-filter").value.trim().toLowerCase();
			const rows = contacts.filter((row: { did: string; handle: string }) =>
				`${row.handle} ${row.did}`.toLowerCase().includes(query),
			);
			element("contact-count").textContent = `${rows.length} of ${contacts.length} contacts`;
			const body = element("future-contacts");
			body.replaceChildren();
			for (const row of rows) {
				const tr = document.createElement("tr");
				for (const text of [row.handle, row.did, date(row.optedAt)]) {
					const td = document.createElement("td");
					td.textContent = text;
					tr.append(td);
				}
				body.append(tr);
			}
		};
		element("contact-filter").oninput = renderContacts;
		renderContacts();
		const tbody = element("responses");
		tbody.replaceChildren();
		for (const row of admin.responses) {
			const tr = document.createElement("tr");
			for (const text of [row.handle, row.attendance ?? "Not answered", row.button ?? "No"]) {
				const td = document.createElement("td");
				td.textContent = text;
				tr.append(td);
			}
			tbody.append(tr);
		}
	}
}
element<HTMLFormElement>("login").addEventListener("submit", async (event) => {
	event.preventDefault();
	status.textContent = "Starting Bluesky sign-in…";
	try {
		const input = loginHandle(element<HTMLInputElement>("handle").value);
		if ("error" in input) throw Error(input.error);
		const data = await api("/oauth/login", "POST", input);
		location.assign(data.url);
	} catch (error) {
		message(error);
	}
});
element<HTMLFormElement>("response").addEventListener("change", preview);
for (const id of ["style", "text-position", "text-color", "replace-artwork", "button-label"]) {
	element(id).addEventListener(id === "button-label" ? "input" : "change", () => {
		artworkEdited = true;
		preview();
	});
}
element<HTMLFormElement>("response").addEventListener("submit", async (event) => {
	event.preventDefault();
	const account = accountGeneration;
	try {
		const attendance = selectedAttendance();
		const button = element<HTMLInputElement>("button-opt-in").checked
			? (element<HTMLSelectElement>("style").value as ButtonStyle)
			: null;
		const replaceArtwork = element<HTMLInputElement>("replace-artwork").checked;
		const futureMeetups = element<HTMLInputElement>("future-meetups").checked;
		const label = normalizeButtonLabel(element<HTMLInputElement>("button-label").value);
		if (button === "handle" && !label) throw Error(BUTTON_LABEL_GUIDANCE);
		const source = button
			? state.response?.artwork && !replaceArtwork
				? state.preview.saved
				: state.preview.profile
			: null;
		const position = element<HTMLSelectElement>("text-position").value as TextPosition;
		const color = element<HTMLSelectElement>("text-color").value as TextColor;
		const oldArtwork = state.response?.artwork;
		const preserveArtwork =
			!!oldArtwork && !artworkEdited && !replaceArtwork && button === oldArtwork.style;
		const eventUnchanged =
			visibilitySelect.value === storedVisibility(state.response?.visibility) &&
			attendance === (state.response?.attendance ?? null) &&
			button === (state.response?.artwork?.style ?? null) &&
			!replaceArtwork &&
			(!button || preserveArtwork);
		if (eventUnchanged) {
			await api("/api/preferences", "PUT", {
				futureMeetups,
				expectedVersion: state.responseVersion,
			});
		} else
			await api("/api/response", "PUT", {
				attendance,
				visibility: visibilitySelect.value as AttendanceVisibility,
				futureMeetups,
				button,
				replaceArtwork,
				expectedVersion: state.responseVersion,
				...(button && !preserveArtwork ? { ...(label ? { label } : {}), position, color } : {}),
				artworkSource: source,
				artworkApproval:
					button && source ? buttonApproval(source, button, label ?? "", position, color) : null,
			});
		if (account !== accountGeneration) return;
		await load();
		if (account !== accountGeneration) return;
		status.textContent = "Signup saved. Return here to change or delete it.";
	} catch (error) {
		if (account === accountGeneration) message(error);
	}
});
element("save-visibility").addEventListener("click", async () => {
	const account = accountGeneration;
	try {
		await api("/api/visibility", "PUT", {
			visibility: visibilitySelect.value,
			expectedVersion: state.responseVersion,
		});
		if (account !== accountGeneration) return;
		await load();
		if (account !== accountGeneration) return;
		status.textContent = "Attendance visibility saved. Other saved choices are unchanged.";
	} catch (error) {
		if (account === accountGeneration) message(error);
	}
});
element("cancel").addEventListener("click", async () => {
	if (
		!confirm(
			"Delete your attendance, saved button artwork, and future-meetup preference? This cannot recall copies already downloaded or printed.",
		)
	)
		return;
	const account = accountGeneration;
	try {
		await api("/api/signup", "DELETE", { expectedVersion: state.responseVersion });
		if (account !== accountGeneration) return;
		await load();
		if (account !== accountGeneration) return;
		status.textContent = "Signup and future-meetup preference deleted.";
	} catch (error) {
		if (account === accountGeneration) message(error);
	}
});
element("logout").addEventListener("click", async () => {
	accountGeneration++;
	const generation = ++loadGeneration;
	state = { ...state, profile: null, response: null, futureMeetups: false, admin: false };
	savedSummary();
	element("directory").replaceChildren();
	element("directory-status").textContent = "";
	element("signed-in").hidden = true;
	element("signed-out").hidden = false;
	element("operator").hidden = true;
	element("identity").textContent = "";
	element("counts").textContent = "";
	element("future-contacts").replaceChildren();
	element("responses").replaceChildren();
	element("contact-count").textContent = "";
	try {
		await api("/api/logout", "POST", {});
		if (generation !== loadGeneration) return;
		await load();
		status.textContent = "Signed out. Your signup remains until you delete it.";
	} catch (error) {
		if (generation === loadGeneration) message(error);
	}
});
void load()
	.then(() => {
		status.textContent = "";
	})
	.catch(message);

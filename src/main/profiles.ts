/**
 * Profile management facade over pi-plus-sdk's profile API (bundled
 * pi-hub): profiles.json CRUD at ~/.pi/profiles.json plus per-profile
 * materialized agent dirs at ~/.pi/pi-hub/profiles/<name>/ (auth.json,
 * settings.json, models.json, shared links). The desktop no longer mirrors
 * the pi-hub file contract itself — app, `pipi` CLI and pi share the SDK's
 * single implementation, and profile edits re-materialize so the next
 * session creation picks them up.
 *
 * Tokens never leave the main process: DTOs expose only `hasToken`, and a DTO
 * update keeps the stored token unless the user typed a new one (`token: ""`
 * clears). `packages` edits made under a profile are synced back to the
 * source agent settings at exit via syncAllToSource().
 */

import "./sdk-shim.ts";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Profile, ProfilesData } from "pi-plus-sdk";
import type { ProfileAuthStatusDTO, ProfileDTO, ProfilesDataDTO } from "../shared/ipc-types.ts";

// Imported dynamically so the sdk-shim module (a static import above) installs
// the global require before pi-plus-sdk's ESM bundle evaluates — static
// imports of externals would be hoisted above the shim by the bundler. Same
// pattern as session-host.ts; the module-level await keeps ProfileStore
// methods synchronous for the IPC handlers.
const sdk = await import("pi-plus-sdk");
const {
	AGENT_DIR,
	addProfile,
	addProfileModel,
	findProfile,
	getDefaultProfileName,
	loadProfiles,
	materializeProfile,
	profileDirFor,
	removeProfile,
	removeProfileDir,
	removeProfileModel,
	renameProfile,
	setDefaultProfile,
	setProfileDefaultModel,
	syncProfilePackagesToSource,
	updateProfile,
} = sdk;

export type { Profile, ProfilesData };

function toDTO(profile: Profile): ProfileDTO {
	const { token, ...rest } = profile;
	return { ...rest, hasToken: Boolean(token) };
}

export class ProfileStore {
	private usedProfileDirs = new Set<string>();
	/** Wired by main to broadcast profile changes to the renderer. */
	onChanged: (() => void) | null = null;

	list(): ProfilesDataDTO {
		const data = loadProfiles();
		const profiles: Record<string, ProfileDTO> = {};
		for (const [name, profile] of Object.entries(data.profiles)) profiles[name] = toDTO(profile);
		// getDefaultProfileName() returns undefined when no default profile is set.
		return { profiles, default: getDefaultProfileName() };
	}

	/**
	 * The models set on a profile. pi-hub stores bare model ids (max 3, or the
	 * legacy single `model`); the provider lives on the profile. Returns null
	 * for tabs without a profile; ids may be empty when none are configured.
	 * `default` is the profile's declared default model, resolved the same way
	 * the SDK's materializer does it: the declared model when it's in the list,
	 * else the list head.
	 */
	profileModels(profileName: string | null): { provider?: string; ids: string[]; default?: string } | null {
		if (!profileName) return null;
		const profile = findProfile(profileName);
		if (!profile) return null;
		const ids = profile.models?.length ? [...profile.models] : profile.model ? [profile.model] : [];
		return { provider: profile.provider, ids, default: profile.model && ids.includes(profile.model) ? profile.model : ids[0] };
	}

	/** Resolve the agent dir for a tab: materialized profile dir or the source agent dir. */
	resolveAgentDir(profileName: string | null): { agentDir: string; error?: string } {
		if (!profileName) return { agentDir: AGENT_DIR };
		const profile = findProfile(profileName);
		if (!profile) return { agentDir: AGENT_DIR, error: `Profile '${profileName}' not found; using default agent dir.` };
		const agentDir = materializeProfile(profileName, profile);
		this.usedProfileDirs.add(agentDir);
		return { agentDir };
	}

	create(name: string, dto: ProfileDTO): void {
		addProfile(name, this.mergeToken(name, dto));
		this.afterChange(name);
	}

	update(name: string, dto: ProfileDTO): void {
		updateProfile(name, this.mergeToken(name, dto));
		this.afterChange(name);
	}

	remove(name: string): void {
		removeProfile(name);
		removeProfileDir(name);
		this.notifyChanged();
	}

	rename(oldName: string, newName: string): void {
		renameProfile(oldName, newName);
		this.afterChange(newName);
	}

	setDefault(name: string): void {
		setDefaultProfile(name);
		this.notifyChanged();
	}

	/** Select a profile's default model (the position materialization writes as
	 *  settings.defaultModel). Reuses afterChange() to re-materialize; returns
	 *  the SDK's human-readable message for the caller's UI feedback. */
	setDefaultModel(name: string, model: string): string {
		const message = setProfileDefaultModel(name, model);
		this.afterChange(name);
		return message;
	}

	/** Append a model to a profile without selecting it (SDK enforces the
	 *  duplicate / 3-model bounds). Re-materializes like the other edits. */
	addModel(name: string, model: string): string {
		const message = addProfileModel(name, model);
		this.afterChange(name);
		return message;
	}

	/** Remove a model from a profile; the default promotes to the next
	 *  remaining model (SDK semantics). */
	removeModel(name: string, model: string): string {
		const message = removeProfileModel(name, model);
		this.afterChange(name);
		return message;
	}

	/**
	 * Resolve the login target for a profile: its agent dir (where
	 * loginProvider persists auth.json) plus the provider to log into
	 * (`providerArg` wins — the form may hold an unsaved provider choice).
	 * A stored profile is re-materialized first; materializeProfile only
	 * touches auth.json when a token is set, so an existing OAuth entry
	 * survives. A draft (unsaved, form-only) profile just gets its dir
	 * created — signing in never persists the profile itself, and a later
	 * create/update materialization keeps the auth.json the login wrote.
	 */
	loginTarget(name: string, providerArg?: string): { agentDir: string; provider: string } {
		const stored = findProfile(name);
		const provider = providerArg?.trim() || stored?.provider;
		if (!provider) throw new Error(`Profile '${name}' has no provider — pick one to sign in.`);
		const agentDir = stored ? materializeProfile(name, stored) : profileDirFor(name);
		if (!stored) mkdirSync(agentDir, { recursive: true });
		this.usedProfileDirs.add(agentDir);
		return { agentDir, provider };
	}

	/** Drop a draft login's profile dir (created by loginTarget) when the
	 *  profile was never saved; a stored profile's dir is never touched. */
	cleanProfileDir(name: string): void {
		if (findProfile(name)) return;
		removeProfileDir(name);
	}

	/**
	 * Non-secret summary of <profileDir>/auth.json: which providers have stored
	 * credentials and of what type. Values never cross IPC — only keys/tags.
	 * Lets the form show "signed in via <provider>" after an earlier login,
	 * even though the DTO itself has no token.
	 */
	authStatus(name: string): ProfileAuthStatusDTO {
		const file = path.join(profileDirFor(name), "auth.json");
		try {
			if (!existsSync(file)) return { providers: [] };
			const data = JSON.parse(readFileSync(file, "utf8")) as Record<string, { type?: unknown }>;
			return {
				providers: Object.entries(data)
					.filter(([, entry]) => entry?.type === "api_key" || entry?.type === "oauth")
					.map(([id, entry]) => ({ id, type: entry.type as "api_key" | "oauth" })),
			};
		} catch (err) {
			console.warn(`[profiles] auth.json read failed for '${name}'`, err);
			return { providers: [] };
		}
	}

	/**
	 * DTO updates never carry the stored token unless the user typed a new one:
	 * `token: string` replaces, `token: ""` clears, absent keeps existing.
	 */
	private mergeToken(name: string, dto: ProfileDTO): Profile {
		const existing = findProfile(name);
		const { hasToken, token, ...rest } = dto;
		const profile: Profile = { ...rest };
		if (token === "") {
			// explicit clear
		} else if (typeof token === "string") {
			profile.token = token;
		} else if (existing?.token !== undefined) {
			profile.token = existing.token;
		}
		return profile;
	}

	private afterChange(name: string): void {
		// Re-materialize so the change is picked up on next session creation.
		const profile = findProfile(name);
		if (profile) {
			try {
				materializeProfile(name, profile);
			} catch (err) {
				console.warn(`[profiles] re-materialization failed for '${name}'`, err);
			}
		}
		this.notifyChanged();
	}

	/** Sync packages edits made under any used profile back to the source settings. */
	syncAllToSource(): void {
		for (const dir of this.usedProfileDirs) {
			try {
				syncProfilePackagesToSource(dir);
			} catch (err) {
				console.warn(`[profiles] package sync failed for ${dir}`, err);
			}
		}
	}

	private notifyChanged(): void {
		try {
			this.onChanged?.();
		} catch (err) {
			console.warn("[profiles] change broadcast failed", err);
		}
	}
}

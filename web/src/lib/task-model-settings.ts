import type { LLMProfile, Task } from "./types";

// The server and older mock payloads both occur in saved configurations.
// Radix/combobox values must use a consistent string identity.
export function settingsProfiles(profiles: LLMProfile[]): LLMProfile[] {
  return profiles.map((profile) => ({ ...profile, id: String(profile.id) }));
}
export function taskModelSelection(task: Task) {
  const ids = task.llm_profile_ids?.length
    ? task.llm_profile_ids.map(String)
    : task.llm_profile_id
      ? [String(task.llm_profile_id)]
      : [];
  const requested = String(task.active_llm_profile_id ?? "");
  return { ids, active: ids.includes(requested) ? requested : (ids[0] ?? "") };
}

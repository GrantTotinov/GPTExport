/*
 * ---------------------------------------------------------
 * SHARED SETTINGS TYPES
 * ---------------------------------------------------------
 *
 * Used by both popup.ts (reads settings when building the
 * export) and options.ts (reads/writes settings from the
 * options page). Keeping this in one file means the two
 * can't drift out of sync with different defaults or
 * option values.
 */
export interface Settings {
    includeTimestamp: boolean;
    headingStyle: "h2" | "bold" | "none";
    messageSeparator: "single" | "double" | "rule";
}

export const DEFAULT_SETTINGS: Settings = {
    includeTimestamp: false,
    headingStyle: "h2",
    messageSeparator: "double"
};

export const SEPARATOR_TEXT: Record<
    Settings["messageSeparator"],
    string
> = {
    single: "\n",
    double: "\n\n",
    rule: "\n\n---\n\n"
};

export async function loadSettings(): Promise<Settings> {
    const stored =
        await chrome.storage.sync.get({
            ...DEFAULT_SETTINGS
        } as Record<string, unknown>);

    return stored as unknown as Settings;
}

export async function saveSettings(
    settings: Settings
): Promise<void> {
    await chrome.storage.sync.set(settings);
}

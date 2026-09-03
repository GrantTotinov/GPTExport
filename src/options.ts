import {
  type Settings,
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
} from "./settings.ts";

const saveButton = document.getElementById("save") as HTMLButtonElement;

const statusLabel = document.getElementById("status") as HTMLSpanElement;

const includeTimestampInput = document.getElementById(
  "includeTimestamp",
) as HTMLInputElement;

function getRadioValue<T extends string>(name: string, fallback: T): T {
  const checked = document.querySelector<HTMLInputElement>(
    `input[name="${name}"]:checked`,
  );

  return (checked?.value as T) ?? fallback;
}

function setRadioValue(name: string, value: string): void {
  const input = document.querySelector<HTMLInputElement>(
    `input[name="${name}"][value="${value}"]`,
  );

  if (input) {
    input.checked = true;
  }
}

function applySettingsToForm(settings: Settings): void {
  setRadioValue("headingStyle", settings.headingStyle);
  setRadioValue("messageSeparator", settings.messageSeparator);

  includeTimestampInput.checked = settings.includeTimestamp;
}

function readSettingsFromForm(): Settings {
  return {
    headingStyle: getRadioValue("headingStyle", DEFAULT_SETTINGS.headingStyle),
    messageSeparator: getRadioValue(
      "messageSeparator",
      DEFAULT_SETTINGS.messageSeparator,
    ),
    includeTimestamp: includeTimestampInput.checked,
  };
}

async function init(): Promise<void> {
  const settings = await loadSettings();

  applySettingsToForm(settings);
}

saveButton.addEventListener("click", async () => {
  const settings = readSettingsFromForm();

  await saveSettings(settings);

  statusLabel.classList.add("visible");

  setTimeout(() => {
    statusLabel.classList.remove("visible");
  }, 1500);
});

init();

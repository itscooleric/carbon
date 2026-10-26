export const THEME_KEY = "envoy.carbon.theme";
export const THEMES = ["system", "dark", "light"];

/** Resolve a local preference without involving portable Stack metadata. */
export function resolveTheme(preference, systemDark) {
  return preference === "light" || preference === "dark"
    ? preference
    : systemDark
      ? "dark"
      : "light";
}

/** Apply and persist the user's override; denied storage never blocks the notebook. */
export function initTheme(win, select, status) {
  let preference = "system";
  let storage;
  const media = win.matchMedia("(prefers-color-scheme: dark)");
  try {
    storage = win.localStorage;
    const saved = storage.getItem(THEME_KEY);
    if (THEMES.includes(saved)) preference = saved;
  } catch {
    status.textContent =
      "Theme applies to this window; preference storage unavailable.";
  }
  const apply = () => {
    win.document.documentElement.dataset.theme = resolveTheme(
      preference,
      media.matches,
    );
    select.value = preference;
  };
  select.addEventListener("change", () => {
    preference = THEMES.includes(select.value) ? select.value : "system";
    apply();
    try {
      if (!storage) throw new Error("Storage unavailable");
      storage.setItem(THEME_KEY, preference);
      status.textContent = "";
    } catch {
      status.textContent =
        "Theme applies to this window; preference could not be saved.";
    }
  });
  media.addEventListener("change", apply);
  apply();
}

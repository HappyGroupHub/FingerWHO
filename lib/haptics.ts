"use client";

/**
 * Vibration where the browser allows it (Android). iOS has no web vibration
 * API; the old `<input switch>` workaround needs a real tap on the switch
 * since early 2025 and was shut off entirely in iOS 26.5, so iPhones stay silent.
 */
export function haptic(pattern: number | number[] = 12) {
  if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") navigator.vibrate(pattern);
}

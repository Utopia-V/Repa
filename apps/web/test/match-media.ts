import { vi } from "vitest";

export function mockMatchMedia(isMobile = false) {
  const media = Object.assign(new EventTarget(), { matches: isMobile, media: "(max-width: 767px)" });
  vi.stubGlobal("matchMedia", vi.fn(() => media));
  return media;
}

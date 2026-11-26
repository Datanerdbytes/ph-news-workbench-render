// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NarrationModeSelector } from "./narration-mode-selector";

afterEach(cleanup);

describe("NarrationModeSelector", () => {
  it("exposes one selected mode and reports changes", () => {
    const onModeChange = vi.fn();
    render(
      <NarrationModeSelector mode="voice" onModeChange={onModeChange} />,
    );

    expect(screen.getByRole("button", { name: "Off" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(
      screen.getByRole("button", { name: "Voice-over" }).getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Talking avatar" }));
    expect(onModeChange).toHaveBeenCalledWith("avatar");
  });

  it("disables every mode while the composer is locked", () => {
    render(<NarrationModeSelector mode="off" onModeChange={vi.fn()} disabled />);
    for (const name of ["Off", "Voice-over", "Talking avatar"]) {
      expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(
        true,
      );
    }
  });
});

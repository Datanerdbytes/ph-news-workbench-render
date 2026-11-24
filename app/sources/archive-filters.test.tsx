// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArchiveFilters } from "./archive-filters";

const today = "2026-11-24";

function props(overrides: Partial<React.ComponentProps<typeof ArchiveFilters>> = {}) {
  return {
    range: "today" as const,
    date: today,
    month: "2026-11",
    query: "",
    today,
    busy: false,
    onRangeChange: vi.fn(),
    onDateChange: vi.fn(),
    onMonthChange: vi.fn(),
    onQueryChange: vi.fn(),
    onReset: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ArchiveFilters", () => {
  it("debounces search and submits trimmed text immediately on Enter", () => {
    const onQueryChange = vi.fn();
    const controls = props({ onQueryChange });
    render(<ArchiveFilters {...controls} />);
    const input = screen.getByRole("searchbox", { name: "Search stories" });

    fireEvent.change(input, { target: { value: "  Maria Santos  " } });
    act(() => vi.advanceTimersByTime(349));
    expect(onQueryChange).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onQueryChange).toHaveBeenCalledWith("Maria Santos");

    onQueryChange.mockClear();
    fireEvent.change(input, { target: { value: "  flood resilience  " } });
    fireEvent.submit(screen.getByRole("search"));
    expect(onQueryChange).toHaveBeenCalledWith("flood resilience");
  });

  it("clears the current search without waiting for the debounce", () => {
    const controls = props({ query: "Maria Santos" });
    render(<ArchiveFilters {...controls} />);

    fireEvent.click(screen.getByRole("button", { name: "Clear story search" }));

    expect(screen.getByRole("searchbox", { name: "Search stories" })).toHaveValue("");
    expect(controls.onQueryChange).toHaveBeenCalledWith("");
  });

  it("cancels a pending search when Reset is clicked", () => {
    const controls = props();
    render(<ArchiveFilters {...controls} />);
    const input = screen.getByRole("searchbox", { name: "Search stories" });

    fireEvent.change(input, { target: { value: "flood" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    act(() => vi.advanceTimersByTime(350));

    expect(input).toHaveValue("");
    expect(controls.onReset).toHaveBeenCalledOnce();
    expect(controls.onQueryChange).not.toHaveBeenCalled();
  });

  it("syncs external URL changes while keeping the search input focused", () => {
    const controls = props();
    const { rerender } = render(<ArchiveFilters {...controls} />);
    const input = screen.getByRole("searchbox", { name: "Search stories" });
    input.focus();
    fireEvent.change(input, { target: { value: "draft" } });

    rerender(<ArchiveFilters {...controls} query="Manila" />);

    expect(input).toHaveValue("Manila");
    expect(input).toHaveFocus();
  });

  it("shows the matching calendar control and prevents future dates", () => {
    const controls = props();
    const { rerender } = render(<ArchiveFilters {...controls} />);
    expect(screen.getByRole("button", { name: "Reset" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Date range"), { target: { value: "day" } });
    expect(controls.onRangeChange).toHaveBeenCalledWith("day");

    rerender(<ArchiveFilters {...controls} range="day" />);
    const day = screen.getByLabelText("Day");
    expect(day).toHaveAttribute("type", "date");
    expect(day).toHaveAttribute("max", today);
    fireEvent.change(day, { target: { value: "2026-02-03" } });
    expect(controls.onDateChange).toHaveBeenCalledWith("2026-02-03");

    rerender(<ArchiveFilters {...controls} range="month" month="2026-02" />);
    const month = screen.getByLabelText("Month");
    expect(month).toHaveAttribute("type", "month");
    expect(month).toHaveAttribute("max", "2026-11");
    fireEvent.change(month, { target: { value: "2026-01" } });
    expect(controls.onMonthChange).toHaveBeenCalledWith("2026-01");
    expect(screen.getByRole("button", { name: "Reset" })).toBeEnabled();
  });
});

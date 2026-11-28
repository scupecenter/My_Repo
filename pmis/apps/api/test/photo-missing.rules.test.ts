import { describe, expect, it } from "vitest";
import { countPhotos, photoMinCount, photosMissing } from "../src/documents/photo-missing.rules";

const img = (over: Record<string, unknown> = {}) => ({ mime_type: "image/jpeg", is_current: true, superseded_by: null, ...over });

describe("D6 missing photo indicator", () => {
  it("reads min_count only when it is a positive integer", () => {
    expect(photoMinCount({ min_count: 3 })).toBe(3);
    expect(photoMinCount({ min_count: 0 })).toBeNull();
    expect(photoMinCount({ camera_only: true })).toBeNull();
    expect(photoMinCount(null)).toBeNull();
    expect(photoMinCount("x")).toBeNull();
  });
  it("counts only current, not superseded image files", () => {
    expect(countPhotos([img(), img({ mime_type: "application/pdf" }), img({ is_current: false }), img({ superseded_by: "x" }), img({ mime_type: "IMAGE/PNG" })])).toBe(2);
  });
  it("is the minimum less the photos, never below 0, null without a minimum", () => {
    expect(photosMissing({ min_count: 3 }, [img()])).toBe(2);
    expect(photosMissing({ min_count: 1 }, [img(), img()])).toBe(0);
    expect(photosMissing(null, [])).toBeNull();
  });
});

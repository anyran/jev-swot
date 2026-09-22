import { describe, expect, it } from "vitest";
import * as ort from "onnxruntime-web/webgpu";
import { decodeCtc, detectFormulaLayout, PaddleOcr, projectQuadPoint, sortTextBoxes, unrotateBox } from "./ocr";

describe("OCR perspective mapping", () => {
  it("maps destination corners onto a skewed source quadrilateral", () => {
    const quad = [{ x: 10, y: 20 }, { x: 110, y: 10 }, { x: 100, y: 80 }, { x: 20, y: 90 }] as const;
    [[0, 0], [1, 0], [1, 1], [0, 1]].forEach(([u, v], index) => {
      const point = projectQuadPoint([...quad], u, v);
      expect(point.x).toBeCloseTo(quad[index].x);
      expect(point.y).toBeCloseTo(quad[index].y);
    });
  });

  it("interpolates the center of an affine rectangle", () => {
    const center = projectQuadPoint([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 40 }, { x: 0, y: 40 }], 0.5, 0.5);
    expect(center.x).toBeCloseTo(50);
    expect(center.y).toBeCloseTo(20);
  });
});

describe("OCR CTC decoding", () => {
  it("collapses repeated symbols and reports low-confidence characters", () => {
    const tensor = new ort.Tensor("float32", new Float32Array([
      .01, .9, .09,
      .01, .8, .19,
      .8, .1, .1,
      .1, .2, .4
    ]), [1, 4, 3]);
    const decoded = decodeCtc(tensor, ["blank", "A", "B"]);
    expect(decoded.text).toBe("AB");
    expect(decoded.lowConfidenceRatio).toBe(0.5);
  });
});

describe("OCR rotation coordinates", () => {
  it("maps clockwise rotated boxes back to the original crop", () => {
    const box = unrotateBox({ x: 20, y: 10, width: 30, height: 40, confidence: 1, text: "x" }, 100, 200, 90);
    expect(box.x).toBe(10);
    expect(box.y).toBe(150);
    expect(box.width).toBe(40);
    expect(box.height).toBe(30);
  });
});

describe("OCR visual warning heuristics", () => {
  it("flags a thin fraction-like line and small superscript boxes", () => {
    expect(detectFormulaLayout([
      { x: 0, y: 0, width: 60, height: 20 },
      { x: 0, y: 24, width: 70, height: 2 },
      { x: 4, y: 32, width: 8, height: 8 },
      { x: 30, y: 32, width: 8, height: 8 }
    ])).toBe(true);
  });
  it("does not flag ordinary same-size text rows", () => {
    expect(detectFormulaLayout([
      { x: 0, y: 0, width: 120, height: 20 },
      { x: 0, y: 28, width: 110, height: 20 },
      { x: 0, y: 56, width: 100, height: 20 }
    ])).toBe(false);
  });
});

describe("OCR reading order", () => {
  it("groups overlapping text boxes into rows before sorting left to right", () => {
    const ordered = sortTextBoxes([
      { x: 80, y: 42, width: 30, height: 14, text: "B" },
      { x: 10, y: 8, width: 40, height: 14, text: "题干" },
      { x: 10, y: 40, width: 30, height: 16, text: "A" },
      { x: 80, y: 9, width: 30, height: 12, text: "内容" }
    ]);
    expect(ordered.map((box) => box.text)).toEqual(["题干", "内容", "A", "B"]);
  });
});

describe("OCR cancellation", () => {
  it("stops before loading models when the request is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(new PaddleOcr().recognize("data:image/png;base64,AA==", { x: 0, y: 0, width: 1, height: 1 }, 1, false, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});

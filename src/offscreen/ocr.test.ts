import { describe, expect, it } from "vitest";
import * as ort from "onnxruntime-web/webgpu";
import { decodeCtc, projectQuadPoint, unrotateBox } from "./ocr";

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

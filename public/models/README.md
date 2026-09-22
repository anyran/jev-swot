# PP-OCRv5 model assets

Download the pinned official PaddlePaddle ONNX assets during development:

```bash
npm run models:fetch
npm run verify:models
```

This creates:

- `ppocrv5-mobile-det.onnx`
- `ppocrv5-mobile-rec.onnx`
- `ppocrv5-dict.txt`

The script pins immutable Hugging Face repository revisions and records SHA-256
hashes in `model-manifest.json`. Model binaries are intentionally gitignored;
release builds must run the fetch and verify steps before `npm run build`. The
extension reports a recoverable error when files are absent; DOM and vision
recognition continue to work.

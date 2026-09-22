# PP-OCRv5 model assets

Place the pinned ONNX assets here before packaging a release:

- `ppocrv5-mobile-det.onnx`
- `ppocrv5-mobile-rec.onnx`
- `ppocrv5-dict.txt`

Run `npm run verify:models` to verify presence and hashes recorded in
`model-manifest.json`. The extension reports a recoverable error when the files
are absent; DOM and vision recognition continue to work.

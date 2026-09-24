# Third-party notices

The extension ZIP includes the full license texts for the production dependency tree in
`third_party_licenses/`. The files are copied from the lockfile-resolved packages during
the production build. The separately included `ONNXRuntime-ThirdPartyNotices.txt` is from
the exact ONNX Runtime v1.30.0 source revision shown below.

| Component | Version | License |
| --- | ---: | --- |
| PaddleOCR PP-OCRv5 model assets | pinned model revisions in `models/model-manifest.json` | Apache-2.0 |
| ONNX Runtime Web / ONNX Runtime Common | 1.30.0 | MIT |
| flatbuffers | 25.9.23 | Apache-2.0 |
| guid-typescript | 1.0.9 | ISC |
| long | 5.3.2 | Apache-2.0 |
| platform | 1.3.6 | MIT |
| protobufjs and installed `@protobufjs/*` helpers | 7.6.6 / lockfile-resolved versions | BSD-3-Clause |
| React / React DOM / scheduler | 19.3.0 / 19.3.0 / 0.28.0 | MIT |
| `@types/node` / `undici-types` (transitive type packages) | 26.6.2 / 8.9.0 | MIT |

The ONNX Runtime notices cover additional third-party components included by that upstream
distribution. Build-only dependencies such as Vite and `@vitejs/plugin-react` are not part
of the extension ZIP; the React plugin is kept in `devDependencies`.

`guid-typescript@1.0.9` declares ISC in its npm package metadata, but its published archive
does not include a separate license file. The bundled ISC text records the package author
field (`nicolas`) as the available attribution. The PP-OCRv5 model files and their SHA-256
hashes are recorded in `public/models/model-manifest.json`.

Source references:

- [ONNX Runtime v1.30.0](https://github.com/microsoft/onnxruntime/tree/v1.30.0)
- [PaddleOCR release/3.0](https://github.com/PaddlePaddle/PaddleOCR/tree/release/3.0)
- [flatbuffers](https://github.com/google/flatbuffers)
- [protobuf.js](https://github.com/protobufjs/protobuf.js)
- [React](https://github.com/facebook/react)

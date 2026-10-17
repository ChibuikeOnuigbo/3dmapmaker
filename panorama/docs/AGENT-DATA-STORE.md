# Agent data store — models, desktop database & runtime (`Agent/`)

The `Agent/` directory is the dedicated storage and execution environment for the platform's artificial intelligence models, persistent databases, neural runtime tools, and validation pipelines. It holds code and data only — every Markdown document in this repository lives in `panorama/` (with the sole exception of the root `README.md`).

---

## Subsystem Overview

```
Agent/
├── models/                     Pre-trained neural models & runtime weights
│   ├── panorama_vision_model.onnx      Standard ONNX deep multi-task network (Opset 17)
│   └── panorama_vision_weights.json    Optimized inference weights for browser WebGL/Node.js
├── desktop/                    Desktop application server & database engine
│   ├── db.mjs                  Dual-engine SQLite / JSON relational database
│   ├── server.mjs              REST API server, serves ../panorama and /models
│   ├── model-runner.mjs        High-performance ONNX / analytical model runner
│   ├── cli.mjs                 Command-line database management interface
│   ├── main.mjs                Cross-platform background server launcher
│   ├── electron/               Optional packaged window (Linux/macOS/Windows)
│   └── start.sh / .bat / .command Multi-platform one-click launchers
├── tools-model/                Model training & export pipeline
│   └── train_vision_model.py   PyTorch training & ONNX compilation script
└── tools/                      OpenCV validation & testing tools
    ├── panorama_validate.py    Physical invariant & ORB continuity gate
    ├── scene_synth.py          Test equirectangular panorama synthesizer
    └── tests/                  Pytest suite for feature tracking & continuity
```

---

## Detailed Data & Component Explanations

### 1. `models/` — Neural Vision & Optics Weights
- **`panorama_vision_model.onnx`**
  - **Format**: Standard ONNX model format (`ir_version=10`, `opset_imports=[opset 17]`).
  - **Architecture**: Multi-layer perceptron with shared representations ($16 \to 64 \to 64$) branching into 7 task-specific heads:
    1. `rayTracing` (4 dims): Ambient occlusion factor, specular intensity, light bounce gain, surface roughness.
    2. `depth3D` (3 dims): Subtle stereoscopic parallax scale ($\le 0.05$m), depth relief bias, depth clipping.
    3. `denoise` (4 dims): Bilateral spatial sigma, bilateral range sigma, unsharp boost, contrast lift.
    4. `calc` (4 dims): Epipolar curl, horizon curvature, spherical Jacobian determinant, irradiance flux.
    5. `wideAngle` (3 dims): Rectilinear k1 coefficient, Panini cylindrical compression, FOV barrel distortion compensation.
    6. `viewIllusion` (3 dims): Atmospheric aerial haze, micro-wobble damping, horizon depth shift.
    7. `adaptiveMorph` (4 dims): Cubic ease-out weight, cubic ease-in weight, smoothstep weight, dynamic hold exponent.
  - **Usage**: Runs natively with `onnxruntime` on Linux, macOS, and Windows.
- **`panorama_vision_weights.json`**
  - **Format**: Portable JSON containing exact layer weights, biases, head definitions, and normalization parameters.
  - **Purpose**: Enables zero-dependency in-browser WebGL shader uniform generation and offline Node.js execution without external binary dependencies.

### 2. `desktop/` — Desktop Database & API Runtime
- **`db.mjs`**
  - **Storage Engine**: Relational SQLite via `node:sqlite` (Node.js $\ge 22.5$) with automatic zero-install fallback to JSON document storage on older runtimes.
  - **Content Addressing**: Images are stored deduplicated by `sha256Hex` on disk, allowing large photo worlds to share identical frames at zero incremental storage cost.
  - **Tables**: `worlds`, `assets`, `revisions` (30 rolling snapshots), `events` (audit log), and `settings`.
- **`server.mjs`**
  - **App root**: serves the standalone site from `../panorama/`; the app's
    neural weights are also exposed at `/models/…` from `Agent/models/`.
  - **API Surface**:
    * `GET /api/health`: Database health status and OS platform info.
    * `GET /api/model/info`: Active neural ONNX model metadata and head offsets.
    * `POST /api/model/predict`: Real-time multi-task inference predicting all 7 optical heads from camera feature vectors.
    * `GET/POST /api/worlds`: World graph retrieval, creation, and listing.
    * `GET /api/worlds/:id/assets/:assetId`: Content-addressed binary image streaming.
    * `POST /api/worlds/:id/pworld`: Exports the world as a self-contained `.pworld` archive.
    * `POST /api/import`: Imports external `.pworld` archives into the local database.
- **`model-runner.mjs`**
  - Evaluates neural predictions on the server side using either native ONNX runtime bindings or analytical multi-layer matrix multiplication.
- **`cli.mjs`**
  - Terminal utility for headless maintenance: `stats`, `list`, `info <id>`, `import <file>`, `export <id>`, `delete <id>`, `gc` (reclaims unreferenced asset files), and `model --predict`.

### 3. `tools-model/` — Training Pipeline
- **`train_vision_model.py`**
  - Synthetic training loop generating 10,000 diverse physical optical scenarios across indoor and outdoor environments.
  - Compiles the trained PyTorch network directly to `models/panorama_vision_model.onnx` with verified IR version bounds (`ir_version=10`) and exports `models/panorama_vision_weights.json`.

### 4. `tools/` — OpenCV Verification Pipeline
- **`panorama_validate.py`**
  - Python/OpenCV continuity validator testing ORB keypoint matching, structural consistency, color balance, and perceptual hashing distance.
  - Rejects discontinuous or hallucinated hops using a distance-aware mathematical threshold.
- **`requirements.txt`**
  - Minimal Python dependencies (`opencv-python-headless`, `numpy`, `onnx`, `onnxruntime`, `pytest`).

---

## Running the desktop build

```bash
node Agent/desktop/main.mjs               # from the repository root
bash Agent/desktop/start.sh               # Linux launcher
bash Agent/desktop/start.command          # macOS launcher
Agent\desktop\start.bat                  # Windows launcher
node Agent/desktop/cli.mjs stats          # CLI / database inspection
node Agent/desktop/cli.mjs model --predict ...  # neural inference
```

The site itself lives in [`../panorama/`](../panorama/). The desktop server,
the web build and the `.pworld` file all read the **same** model artifacts in
this folder.

## Future Updates Protocol
Whenever new models, datasets, or database schemas are introduced:
1. Store all weights and ONNX model artifacts inside `Agent/models/`.
2. Keep desktop server endpoints and database code inside `Agent/desktop/`.
3. Keep training and validation code inside `Agent/tools-model/` and `Agent/tools/`.
4. Document any new data structures or endpoints in `panorama/docs/AGENT-DATA-STORE.md`.

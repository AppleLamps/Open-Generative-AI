# Open Generative AI

Open Generative AI is an open-source creative studio for AI image, video, cinema, lip sync, workflow, and agent-based generation. It can run as a Next.js web app or as a Vite/Electron desktop app with optional local image generation powered by `stable-diffusion.cpp`.

The app is built around a bring-your-own-key Muapi workflow for cloud models, plus a desktop-only local model manager for users who want image generation on their own machine.

![Studio Demo](docs/assets/studio_demo.webp)

## What You Can Build With It

- **Image Studio**: text-to-image, image-to-image, multi-image edits, prompt helpers, generation history, and optional local model generation in the desktop app.
- **Video Studio**: text-to-video, image-to-video, video tools, Seedance extension flows, reusable uploads, and resumable pending jobs.
- **Lip Sync Studio**: portrait image + audio or source video + audio workflows.
- **Cinema Studio**: cinematic image generation with camera, lens, focal length, aperture, aspect ratio, and resolution controls.
- **Workflow Studio**: multi-step AI pipelines using the bundled workflow builder package.
- **Agents**: experimental agent workspace powered by the bundled agent package.
- **Desktop Local Models**: install an inference engine, download supported model files, and generate locally without a Muapi API key.

## Runtimes

This repository currently has two app runtimes:

| Runtime | Command | Purpose |
| --- | --- | --- |
| Next.js app | `npm run dev` | Web app and hosted/self-hosted studio routes under `app/` |
| Vite/Electron desktop app | `npm run electron:dev` | Desktop shell using `src/` and `electron/`, including local model inference |

The desktop renderer is intentionally separate from the Next.js app. Desktop-specific UI lives under `src/`, while the Next.js app uses the React studio package under `packages/studio`.

## Quick Start

### Prerequisites

- Node.js 18 or newer
- npm
- A Muapi API key for cloud generation features

Local image generation in the desktop app can run without a Muapi API key after the engine and model files are installed.

### Install

```bash
git clone https://github.com/Anil-matcha/Open-Generative-AI.git
cd Open-Generative-AI
npm install
```

### Run the Next.js Web App

```bash
npm run dev
```

Open `http://localhost:3000` and enter your Muapi API key when prompted.

### Run the Desktop App in Development

```bash
npm run electron:dev
```

This builds the Vite renderer and launches Electron.

### Build for Production

```bash
# Next.js web app
npm run build
npm run start

# Vite renderer only
npm run vite:build
```

### Build Desktop Installers

```bash
# macOS DMG
npm run electron:build

# Windows NSIS installer
npm run electron:build:win

# Linux AppImage + .deb
npm run electron:build:linux

# All configured desktop targets
npm run electron:build:all
```

Desktop builds are written to `release/`. Published builds, when available, are listed on the [GitHub Releases page](https://github.com/Anil-matcha/Open-Generative-AI/releases).

## Desktop App Notes

The Electron app loads the Vite build from `dist/` and uses a hardened preload bridge for local inference IPC. External links are protocol-allowlisted, the renderer has a CSP in `index.html`, and local model operations are handled in the main process.

### macOS Gatekeeper

If you build or download an unsigned macOS app, Gatekeeper may block it on first launch. You can clear quarantine after moving the app to `/Applications`:

```bash
xattr -cr "/Applications/Open Generative AI.app"
```

Then right-click the app and choose **Open**.

### Windows SmartScreen

Unsigned local builds may trigger SmartScreen. Choose **More info** and **Run anyway** if you trust the build.

### Ubuntu 24.04+ AppArmor

The `.deb` build ships an AppArmor profile for Chromium's user namespace sandbox. Prefer the `.deb` on Ubuntu 24.04+. If an AppImage fails because of `apparmor_restrict_unprivileged_userns`, use the `.deb` build or temporarily run:

```bash
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
```

## Local Model Inference

Local inference is available in the desktop app only.

1. Open **Settings**.
2. Go to **Local Models**.
3. Install the `sd.cpp` inference engine.
4. Download a model.
5. Download required components for Z-Image models when shown.
6. Return to **Image Studio** and switch from **API** to **Local**.

The UI checks whether the engine, selected model, and required components are installed before warming or generating. If anything is missing, it opens the Local Models settings tab instead of surfacing a low-level file error.

### Supported Local Models

| Model | Type | Approx. Size | Notes |
| --- | --- | ---: | --- |
| Z-Image Turbo | Z-Image / GGUF | 2.5 GB + shared aux files | Fast 8-step local generation |
| Z-Image Base | Z-Image / GGUF | 3.5 GB + shared aux files | Higher-detail Z-Image generation |
| Dreamshaper 8 | SD 1.5 | 2.1 GB | Versatile portraits and art |
| Realistic Vision v5.1 | SD 1.5 | 2.1 GB | Photorealistic scenes and people |
| Anything v5 | SD 1.5 | 2.1 GB | Anime and illustration styles |
| SDXL Base 1.0 | SDXL | 6.9 GB | Higher-resolution SDXL generation |

Z-Image models require shared auxiliary files:

- Qwen3-4B text encoder, about 2.4 GB
- FLUX VAE, about 335 MB

Downloads can be cancelled from the Local Models UI. Interrupted downloads may leave `.part` files that the downloader can continue from on a later retry; user-cancelled downloads are cleaned up automatically.

### Custom Local Storage Directory

By default, local inference files are stored under the app user data directory. You can override this with either environment variable:

- `LOCAL_AI_DIR`
- `OPEN_GENERATIVE_AI_LOCAL_DIR`

PowerShell example:

```powershell
$env:LOCAL_AI_DIR = "D:\OpenGenerativeAI\local-ai"
npm run electron:dev
```

Persistent Windows user environment variable:

```powershell
[System.Environment]::SetEnvironmentVariable("LOCAL_AI_DIR", "D:\OpenGenerativeAI\local-ai", "User")
```

Restart the app after changing the storage path.

## Project Structure

```text
Open-Generative-AI/
├── app/                         # Next.js App Router routes and API proxies
├── components/                  # Next.js shell components
├── electron/                    # Electron main/preload and local inference backend
│   ├── main.js
│   ├── preload.js
│   └── lib/
│       ├── localInference.js
│       └── modelCatalog.js
├── src/                         # Vite/Electron renderer UI
│   ├── components/              # Vanilla JS studio components
│   ├── lib/                     # Muapi client, model catalog, local inference client
│   └── styles/                  # Tailwind/global styles
├── packages/
│   ├── studio/                  # React studio package used by the Next.js shell
│   ├── Vibe-Workflow/           # Workflow builder package
│   └── Open-Poe-AI/             # Agent package
├── public/                      # Static assets
├── docs/assets/                 # README/demo assets
├── package.json
├── vite.config.mjs
└── next.config.mjs
```

## Important Scripts

| Script | Description |
| --- | --- |
| `npm run dev` | Start the Next.js development server |
| `npm run build` | Build the Next.js app |
| `npm run start` | Start the built Next.js app |
| `npm run lint` | Run Next lint command configured in `package.json` |
| `npm run vite:dev` | Start the Vite desktop renderer dev server |
| `npm run vite:build` | Build the Vite renderer into `dist/` |
| `npm run electron:dev` | Build the Vite renderer and launch Electron |
| `npm run electron:build` | Build the macOS desktop app |
| `npm run electron:build:win` | Build the Windows desktop installer |
| `npm run electron:build:linux` | Build Linux AppImage and `.deb` artifacts |
| `npm run build:studio` | Build the `packages/studio` React package |
| `npm run setup` | Install dependencies and build `packages/studio` |

## API Integration

Cloud generation uses [Muapi.ai](https://muapi.ai). The client submits a job, stores the returned `request_id` where needed, then polls until the job is complete.

Typical flow:

1. `POST /api/v1/{model-endpoint}` with the model payload and `x-api-key` header.
2. Receive `request_id` or direct output.
3. `GET /api/v1/predictions/{request_id}/result` until the status is complete or failed.
4. Normalize the first output URL for the studio UI.

Uploads use `POST /api/v1/upload_file` and return a hosted URL for image/video/audio-conditioned models.

The Vite dev server proxies `/api` to `https://api.muapi.ai` for browser development. Production desktop builds call the API host directly.

## Data Stored Locally

The app stores user-facing state in browser/Electron renderer storage:

- `muapi_key`: Muapi API key for cloud features.
- `muapi_history`, `video_history`, `lipsync_history`: generation history.
- `muapi_pending_jobs`: pending cloud jobs that should resume after reload.
- Upload history entries and thumbnails for reusing previous reference media.

Local model binaries and weights are stored in the desktop app data directory or the custom directory configured by `LOCAL_AI_DIR`.

## Tech Stack

- Next.js 15
- React 19
- Vite 5
- Electron 33
- Tailwind CSS 4 for the Vite renderer
- Tailwind CSS 3 inside `packages/studio`
- npm workspaces
- Muapi.ai cloud model API
- stable-diffusion.cpp for desktop local image generation

## Development Notes

- The model list in `src/lib/models.js` is generated from `models_dump.json`.
- Desktop local model metadata is mirrored between `electron/lib/modelCatalog.js` and `src/lib/localModels.js`; keep these in sync when adding local models.
- The Electron preload exposes only the `window.localAI` bridge for local inference tasks.
- Long cloud jobs are saved as pending jobs and resumed on reload where supported.
- Verbose Muapi logs are available in development or when `localStorage.muapi_debug` is set to `"1"`.

## Known Follow-Ups

- Add automated tests for renderer navigation, pending job resume, local model setup, and IPC cancellation.
- Add checksum or signature verification for runtime-downloaded local inference binaries and model artifacts.
- Consider unifying the Next.js React studio package and the Vite desktop renderer UI to reduce feature drift.
- Add a repository `LICENSE` file if MIT licensing is intended for distribution.

## Credits

- [Muapi.ai](https://muapi.ai) for cloud model APIs.
- [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp) for local desktop image inference.
- [Vibe Workflow](https://github.com/SamurAIGPT/Vibe-Workflow) for workflow-building concepts and package integration.

## License

This README previously stated MIT licensing, but no `LICENSE` file is currently present in this checkout. Add a `LICENSE` file before publishing or distributing release artifacts if MIT is the intended license.

## Disclaimer

This project is an independent open-source project and is not affiliated with, endorsed by, or associated with Higgsfield, Freepik, Krea, OpenArt, or their respective companies. Third-party names are referenced only for interoperability, comparison, and descriptive context. All trademarks and brand names belong to their respective owners.

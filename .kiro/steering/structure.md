# Structure

## Layout
| Path | Purpose |
|---|---|
| `/` | Frontend: React 19 / Three.js / Vite / TypeScript |
| `src/` | Frontend source. `AppRouter.tsx`, `IntroRoute.tsx`, `workspace/` (repair UI), plus scenes, objects, audio, animations, etc. for the 3D intro |
| `public/` | Models and sounds |
| `scripts/` | Frontend verification and asset scripts (`verify-workspace.mjs`, `verify-scene.mjs`) |
| `backend/` | Independent Node/TypeScript package. Source in `backend/src`, tests in `backend/src/test`, notes in `backend/DEVELOPMENT.md` |
| `.kiro/` | `PROJECT.md`, `KIRO_USAGE.md`, `specs/backend-foundation/` (requirements, design, tasks), `steering/` |

## Branch rules
- `backend` is the active development branch, branched from the UI.
- The 3D environment (gate, camera, stories, audio, characters) must be preserved. Do not modify frontend assets for backend work.
- Backend tasks write only under `backend/` and `.kiro/` unless the request says otherwise.

## Test conventions
- Backend tests live in `backend/src/test/*.test.ts`, compiled with `tsconfig.test.json` to `dist-test/`, run with `node --test dist-test/test/*.js`.
- Build check: `tsc -p tsconfig.json` and `tsc -p tsconfig.test.json` must both exit 0.
- Real-HTTP tests use ephemeral localhost ports and may need to run outside a restricted sandbox.
- Docker behavior uses mock executor tests plus controlled real fixtures run externally.
- Frontend: production build plus `node scripts/verify-workspace.mjs`.
- Code written without running tools is recorded as unverified until external results are logged in `.kiro/PROJECT.md` and `backend/DEVELOPMENT.md`.

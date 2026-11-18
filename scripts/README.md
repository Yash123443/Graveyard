# Local browser demo (Windows)

From the repository root:

```powershell
.\scripts\start-demo.ps1            # browser port 3010 (default)
.\scripts\start-demo.ps1 -Port 3020 # optional explicit port (1024-65535)
```

Scope: by default this is a local demo of one pinned public fixture repository. It is not a public deployment, and nothing here claims support for arbitrary repositories. The default fixture is the demo choice. An alternate repository is a rehearsal of a real project (see "Rehearsal with another public repository").

## Rehearsal with another public repository

Optional, for trying one real project before a demo. Both parameters are required together; give neither to use the default fixture. The placeholders are yours to fill in:

```powershell
.\scripts\start-demo.ps1 -Check -RepositoryUrl https://github.com/<owner>/<repo> -Commit <40-char-lowercase-sha>
.\scripts\start-demo.ps1 -RepositoryUrl https://github.com/<owner>/<repo> -Commit <40-char-lowercase-sha> -Port 3020
```

- `-RepositoryUrl` must be `https://github.com/<owner>/<repo>` (the same rules as the backend: a trailing `.git` is removed, so the canonical form is accepted unchanged; no query, port, credentials, whitespace or extra path). `-Commit` must be a full 40-character lowercase hex SHA that you looked up yourself. The launcher never resolves a branch, tag, short SHA or HEAD, and never pins automatically. Either parameter alone, or an invalid value, exits 1 before anything starts (also with `-Check`).
- Exactly that one URL and commit become the worker's pin and the only URL the demo's job gate accepts. Everything else (loopback binding on 127.0.0.1, the optional `-Port`, Ctrl+C cleanup) is unchanged.
- Limitations: the repository must be public and fit the narrow supported class. That is root `package.json` with `scripts.build` of the form `node FILE` and `scripts.test` of `node --test` or `node --test FILE`, a small lockfile v3, no pre/post hooks, at most 100 files and 1 MiB, with a build that fails. The launcher cannot check this. Other repositories end as `unsupported-repository` or `repository-failing` without a verified repair, and nothing outside the class is executed. A verified repair is not guaranteed even inside the class. Submitting a job sends the bounded build-entry source of that repository to live Kiro, so choose only code you may share. This path is unverified for any repository other than the default fixture.

## Public repository inspection (-InspectPublic)

Optional. Lets the browser submit other public repositories for a read-only assessment, next to the pinned repository:

```powershell
.\scripts\start-demo.ps1 -InspectPublic
.\scripts\start-demo.ps1 -InspectPublic -RepositoryUrl https://github.com/<owner>/<repo> -Commit <40-char-lowercase-sha>
```

- The launcher sets `GRAVEYARD_DEMO_INSPECT_PUBLIC=1` for the harness only. The harness accepts it only together with the browser demo and then turns on the worker's existing `GRAVEYARD_GITHUB_ALLOW_UNPINNED=1`. Without the switch nothing changes: the demo accepts only the pinned URL.
- The demo's job gate forwards any URL that passes the backend's URL check (`https://github.com/<owner>/<repo>`, optional trailing `.git`). Invalid URLs still get a 400 in the workspace. The harness's internal placeholder URL is refused.
- The pinned URL keeps precedence and still runs the npm scripts repair with live Kiro, as before.
- Every other URL is inspected read-only. The worker resolves the repository's current HEAD to a full commit SHA inside the guarded git container and reads `package.json`, `package-lock.json`, `build.mjs` and `test.mjs` as data. Nothing is installed, built or run, no snapshot is copied to the host, and no model is called. The result is `source-inspected`.
- If `package.json` declares `scripts`, the findings come from the same npm scripts profile check a pinned run uses (`scripts.build` and `scripts.test`, no pre/post hooks, lock policy). The workspace shows the resolved commit, the profile checked and the findings. "Root file checks passed" is preliminary: the snapshot limits (100 files, 1 MiB), the dependency download, install, build and tests were not checked. To build, test or repair the repository, pin the reported commit with `-RepositoryUrl` and `-Commit`.
- A private, missing or unreachable repository ends as an infrastructure failure; the launcher cannot tell beforehand whether a repository is public.
- Verified through the local workspace API with Docker. The npm repair fixture passed preliminary root checks, and TRACEWISE returned concrete dependency-policy findings. Both jobs returned a commit SHA and ran in read-only mode.

## Teammate handoff

1. Start Docker Desktop (Linux containers) and make sure `kiro-cli` is installed and logged in.
2. From the repository root, check readiness (read-only; installs, pulls, compiles and starts nothing, sends no model request):
   ```powershell
   .\scripts\start-demo.ps1 -Check
   ```
   It exits 1 with a list of fixes if something is missing (a simulated unavailable Docker returned exit 1). The check passed in Windows PowerShell 5.1 and PowerShell 7. If `GRAVEYARD_GITHUB_E2E_GIT_IMAGE` is set, that exact image is checked instead of `alpine/git:2.47.2`; an empty or invalid value is rejected, as in the harness. Exit 0 only means the tools and images are present. It cannot check the kiro-cli login, and it does not prove a repair works, so do one rehearsal run first.
3. Launch (the same checks run first):
   ```powershell
   .\scripts\start-demo.ps1
   ```
4. Wait for `Workspace: http://127.0.0.1:3010/#/workspace`, open it, paste the fixture URL and give consent:
   `https://github.com/yash123443/graveyard-npm-repair-fixture`
5. Expected browser result: the live event feed shows the stages, then a verified repair with a diff. Use the download button to save the `.diff`. It changes only the inverted guard. The original is never modified.
6. Optional unsupported-repository demonstration: after the job succeeds, click "Clear job from this tab", then submit any other URL. The demo accepts only the fixture, so the workspace shows "This demo accepts only the fixture URL printed by the launcher." and no job is created.
7. Stop with Ctrl+C in the launcher window and wait for cleanup to finish.

This is a local demo on your machine, not a deployment. Submitting a job sends the fixture's bounded build-entry source to Kiro.

Measured results (Codex, 2026-11-17, local Windows machine):
- The one-command launcher worked on the default port 3010 and on the override port 3011, once Docker was started.
- The browser showed "Backend online" and the live event feed with job stages.
- With live Kiro, the pinned public fixture repair was verified, and the browser downloaded a `.diff` that changed only the inverted guard.
- Submitting a wrong repository URL displayed a clear error in the workspace, and no job was created.
- Ctrl+C stopped the worker and Vite and removed the temporary run directories.
- The workspace parser and result checks and the TypeScript compile passed.

Authorship: Kiro wrote the code; Codex ran the tests and the demo.

Prerequisites: Windows with Docker running; `node` (>= 22.13) and `pnpm install` done beforehand in the repository root and in `backend/` (pnpm is not used when the launcher runs); the local images `node:22-alpine` and `alpine/git:2.47.2` (never pulled, same as `pnpm run test:github-e2e`); outbound access to github.com and registry.npmjs.org from Docker; whatever live Kiro setup the existing npm repair mode needs (`GRAVEYARD_WORKER_AGENTS=kiro-v2`).

Behavior:
- The script compiles in `backend/` with `node node_modules/typescript/bin/tsc -p tsconfig.test.json` (no pnpm), then runs the compiled `backend/dist-test/test/manual-github-e2e-check.js` directly with `node` (no test-runner child process, no test timeout) with `GRAVEYARD_BROWSER_DEMO=1` plus the npm repair mode, pinned to `https://github.com/yash123443/graveyard-npm-repair-fixture` at `f3fe0aadbc7b62b28d583e21879ad8bb47f90751`. The values are set for that process only and restored afterwards.
- The harness builds its usual per-run Docker topology (two internal networks and two single-host proxies), starts the real API on an ephemeral 127.0.0.1 port and the real worker, then starts Vite from the repository root with the site's `vite.config.ts`. Only these are overridden: host `127.0.0.1`, your port with `strictPort`, and the `/api` proxy target (the API's port; `/api/health` still maps to `/health`).
- It prints `Workspace: http://127.0.0.1:<port>/#/workspace` and the fixture URL, then waits. No job is submitted for you: open the URL, paste the fixture URL, and give consent. The job token stays in the browser's `sessionStorage` and is never printed. Submitting runs live Kiro, so the fixture's bounded build-entry source is sent to Kiro.
- The API has no repository allow-list option and production code is unchanged. In this demo, a Vite middleware answers `POST /api/jobs` itself: the body's `repoUrl` must be the pinned fixture, else the middleware answers 400 with the message "This demo accepts only the fixture URL printed by the launcher." (a 403 would show in the workspace as a bad saved job credential). Malformed or oversized bodies keep their own handling. Accepted bodies go to the API unchanged. The worker's pin catalog also holds only that URL.
- Stop the demo with Ctrl+C (SIGINT). SIGTERM is not supported: Vite registers its own SIGTERM handler that exits the process. Ctrl+C closes Vite first, then the existing cleanup runs: worker stop with cleanup proof, API close, a leftover-container query for the execution ids of every job the API accepted (browser-created jobs are remembered by id in memory only, never by token), proxies, networks, temporary directories under `backend/.tmp-fixtures`. Problems are printed with the run label. A second Ctrl+C is ignored while shutting down. A Ctrl+C during setup is honored once setup finishes.
- Without `GRAVEYARD_BROWSER_DEMO=1` the harness behaves as before.
- With `-InspectPublic` (`GRAVEYARD_DEMO_INSPECT_PUBLIC=1`) the middleware forwards any valid public GitHub URL instead of only the pinned one, and the worker also runs read-only unpinned inspections (see "Public repository inspection").

# Model optimization

`optimize-dead-tree.mjs` simplifies the supplied high-resolution tree mesh with meshoptimizer while preserving its 3D shape, material maps, and glTF structure. It reads the archived source in `assets-source/dead-tree.glb` and writes the optimized production asset to `public/models/dead-tree.glb`.

The checked-in production model is about 2.6 MB with roughly 190k vertices and 306k triangles, down from 8.0 MB, 752k vertices, and 1.39M triangles. The simplifier's measured relative error was 0.000188 (target 0.01). The original model remains in `assets-source` for future revisions.

Run `node scripts/optimize-dead-tree.mjs` after changing the source model. The script verifies that each optimized meshopt buffer decodes before writing the GLB.

Run `node scripts/optimize-dead-tree.mjs --background` to derive the surrounding-tree asset from the production model. It writes `public/models/dead-tree-background.glb` without replacing the central tree. The background asset has 48,968 triangles (down from 306,054), is 800 KB, and has measured relative simplification error 0.000903. Eight surrounding trees use this model; the central tree retains the original detail.

Run `node scripts/verify-scene.mjs` for geometry regression checks. These verify batching preserves world bounds and animated subtrees, each soul stays within its mesh/triangle budgets, fade values remain valid, and geometry is disposed. This is a CPU geometry check, not a browser FPS benchmark.

The checks also cover soul/caption synchronization at 30–120 FPS, stalled-frame limits, and ghost peek/approach/stare/permanent-disappearance behavior. The final encounter now uses a shared 36-second render-paced clock after a four-second reading pause near the main grave. Tree lanterns and bone mobiles use material batches without additional lights.

The power ritual uses six GPU particle batches for vapor and sparks, with no tube beams. Tests cover individual casting, combined casting, and proper success/failure fade-out. For development-only visual QA, open `/?scenePreview=ritual` or `/?scenePreview=trees`. These deterministic camera setups are disabled in production builds.

Run `node scripts/verify-workspace.mjs` for the repair-workspace checks: the incremental SSE parser (LF/CRLF/CR, every chunk boundary, multiline data, comments, BOM, sticky ids), retry classification (only network failures and 5xx are transient), and URL/token validation. It needs no dependencies beyond the existing `typescript` dev dependency.

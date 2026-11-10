# Model optimization

`optimize-dead-tree.mjs` simplifies the supplied high-resolution tree mesh with meshoptimizer while preserving its 3D shape, material maps, and glTF structure. It reads the archived source in `assets-source/dead-tree.glb` and writes the optimized production asset to `public/models/dead-tree.glb`.

The checked-in production model is about 2.6 MB with roughly 190k vertices and 306k triangles, down from 8.0 MB, 752k vertices, and 1.39M triangles. The simplifier's measured relative error was 0.000188 (target 0.01). The original model remains in `assets-source` for future revisions.

Run `node scripts/optimize-dead-tree.mjs` after changing the source model. The script verifies that each optimized meshopt buffer decodes before writing the GLB.

Run `node scripts/optimize-dead-tree.mjs --background` to derive the surrounding-tree asset from the production model. It writes `public/models/dead-tree-background.glb` without replacing the central tree. The background asset has 48,968 triangles (down from 306,054), is 800 KB, and has measured relative simplification error 0.000903. Eight surrounding trees use this model; the central tree retains the original detail.

Run `node scripts/verify-scene.mjs` for geometry regression checks. These verify batching preserves world bounds and animated subtrees, each soul stays within its mesh/triangle budgets, fade values remain valid, and geometry is disposed. This is a CPU geometry check, not a browser FPS benchmark.

The checks also cover soul/caption synchronization at 30–120 FPS, stalled-frame limits, and ghost peek/approach/stare/permanent-disappearance behavior. The final encounter now uses a shared 36-second render-paced clock after a four-second reading pause near the main grave. Tree lanterns and bone mobiles use material batches without additional lights.

The power ritual uses six GPU particle batches for vapor and sparks, with no tube beams. Tests cover individual casting, combined casting, and proper success/failure fade-out. For development-only visual QA, open `/?scenePreview=ritual` or `/?scenePreview=trees`. These deterministic camera setups are disabled in production builds.

Run `node scripts/verify-workspace.mjs` for the repair-workspace checks: the incremental SSE parser (LF/CRLF/CR, every chunk boundary, multiline data, comments, BOM, sticky ids), retry classification (only network failures and 5xx are transient), and URL/token validation. It needs no dependencies beyond the existing `typescript` dev dependency.

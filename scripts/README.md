# Model optimization

`optimize-dead-tree.mjs` simplifies the supplied high-resolution tree mesh with meshoptimizer while preserving its 3D shape, material maps, and glTF structure. It reads the archived source in `assets-source/dead-tree.glb` and writes the optimized production asset to `public/models/dead-tree.glb`.

The checked-in production model is about 2.6 MB with roughly 190k vertices and 306k triangles, down from 8.0 MB, 752k vertices, and 1.39M triangles. The simplifier's measured relative error was 0.000188 (target 0.01). The original model remains in `assets-source` for future revisions.

Run `node scripts/optimize-dead-tree.mjs` after changing the source model. The script verifies that each optimized meshopt buffer decodes before writing the GLB.

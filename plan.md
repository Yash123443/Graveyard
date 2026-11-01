# GRAVEYARD — Environment Foundation Plan

## Scope

This phase establishes the working 3D environment only. It does not implement the repository story, tombstone interaction, AI agents, or the complete landing-page experience.

## Implementation approach

Use a Vite + React + TypeScript frontend with `@react-three/fiber` and `@react-three/drei` for the WebGL scene graph, `three` for materials and math, and `gsap` for cinematic camera drift and atmosphere timing. Keep the application shell thin: the page owns the loading overlay and scene mount, while the scene owns all environment objects and lighting. All 3D assets live under `public/models/` and are loaded through Drei's GLTF loader so they remain replaceable Blender-compatible files.

The world is composed as a spacious irregular clearing rather than a road or grid: an uneven procedural terrain plane, clusters of generated tombstones, scattered grave props, distant tree silhouettes, broken fence segments, a full moon billboard sphere, layered cloud wisps, ground fog, firefly/dust particles, and a bat flight path crossing the moon. The camera uses a wide cinematic lens and a shallow, continuously eased path through the clearing.

## Project structure

- `src/components/`: page-level orchestration and the asset loading screen.
- `src/scenes/`: the `GraveyardScene` R3F canvas and scene-level composition.
- `src/objects/`: reusable world objects such as graves, trees, fences, clouds, fog and bats.
- `src/animations/`: GSAP camera and atmosphere choreography.
- `src/models/`: typed model-loading wrappers and model metadata.
- `src/sounds/`: reserved for later environmental audio; no story/audio work in this phase.
- `src/styles/`: global reset, color system, typography and shell styling.
- `src/assets/`: local non-model assets and future texture references.
- `public/models/`: generated PBR GLB files used by the scene.
- `public/manus-routes.json`: the route manifest for the root page.

## Design direction

### Candidate styles

- **Northern gothic cinema** — 0.06: moonlit stone, restrained typography and long negative-space compositions.
- **Surrealist dream-horror** — 0.04: uncanny scale, drifting fog and slow impossible movement.
- **Industrial ruin realism** — 0.08: corroded iron, mud, chipped materials and documentary-like restraint.

Chosen: **Northern gothic cinema**.

### Design movement

Northern gothic cinema: a high-contrast, atmospheric horror-game establishing shot built around controlled darkness, cold moonlight and strong silhouettes instead of interface panels.

### Core principles

1. **Silhouette before ornament** — the moon, trees, fence breaks and tombstone clusters read at a glance through shape and light.
2. **Irregularity over repetition** — graves and props are spatially scattered with intentional rotations, scale changes and gaps.
3. **Material truth** — rock, mud, iron, moss and fog carry the scene; no emoji or flat illustration substitutes.
4. **Motion at the edge of perception** — clouds, particles, bats and camera drift move slowly enough to feel cinematic.

### Color philosophy

Midnight blue and near-black provide the void; cold blue-grey carries the ground and stone; a moonlight white-blue is reserved for the full moon and rim light. The palette should feel desaturated, wet and nocturnal rather than neon or fantasy-purple.

### Layout paradigm

A full-viewport scene with minimal overlay chrome. The camera is the layout: negative space opens around the moon while the ground plane pulls the viewer into the clearing. Any future UI should enter as sparse typographic annotations over the world, not as cards or a centered SaaS grid.

### Signature elements

- A full blue-white moon acting as the scene's horizon anchor.
- Low, layered ground fog that slips between irregular gravestones.
- A thin cold-blue rule and small uppercase labels reserved for later UI overlays.

### Interaction philosophy

The scene should feel discovered, not operated. Pointer movement can subtly influence camera parallax later, while motion remains slow and deliberate. No arcade HUD or dashboard controls belong in this foundation.

### Animation

Use GSAP timelines for gentle camera breathing, cloud drift, fog phase offsets and bat flight. Avoid loops that feel mechanical: vary durations, delays and amplitudes, and keep the camera motion on a long ease-in-out curve.

### Typography system

Use a condensed serif display face for future GRAVEYARD wordmark treatment with a neutral grotesk for metadata. The foundation keeps typography minimal and only uses a small loading label so visual hierarchy remains in the world.

### Brand essence

An interactive memorial for abandoned software — quiet, forensic, cinematic. Personality: haunted, precise, atmospheric.

### Brand voice

Headlines should read like evidence, not marketing. Example future lines: “Every dead repo has a cause of death.” and “Walk the perimeter. Read what was left behind.”

### Wordmark & logo

Future wordmark concept: GRAVEYARD in tracked condensed capitals with a hairline vertical fracture interrupting the A/V rhythm, paired with a small coordinate-style subline.

### Signature brand color

`#9eb9cc` — a desaturated moonlit blue-grey that can own the brand without becoming decorative cyan.

## Assets and replacement notes

The catalog has no suitable GLB entries for the requested dead tree or tombstone forms. This phase therefore uses generated, PBR-textured GLBs for a twisted dead tree, a weathered tombstone, and a broken cemetery fence. They are intentionally isolated behind model wrappers and can be replaced later by Blender-authored production assets without changing scene composition.

## Runtime

Vite listens on the managed preview port 3000. The root route is declared in `public/manus-routes.json`. The app should render a loading overlay while GLB assets are fetched, then reveal the canvas with shadows, fog and animation enabled.

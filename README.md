# Dense HHI Interactive Annotator

This local web app supports visual annotation for the Dense Human-Human
Interaction prototype. It plays two-person motion as rendered SMPL-X body
videos when available, lets annotators split a sequence into temporal semantic
segments, and exports JSONL compatible with the existing Dense HHI QA scripts.

## Start

From the repository root:

```bash
python3 -m http.server 8765
```

Open:

```text
http://localhost:8765/interactive_annotator/
```

Do not open `index.html` directly with `file://`; the app loads local JSON
assets through the HTTP server.

## Workflow

1. Pick a sequence from the left panel.
2. Play or scrub the human-shaped motion in the center viewer.
3. Use the bottom timeline to select a segment.
4. Drag a boundary handle to adjust the cut point.
5. Move to a frame and click `Split at Current Frame` to add a segment.
6. Click `Play` on a right-side segment card to replay only that segment.
7. Edit each segment caption in the right panel.
8. Keep each sequence to 2-6 interaction segments.
9. Click `Export JSONL` when annotation is complete.

The app stores edits in browser local storage while you work. Use `Export JSONL`
regularly to keep an external copy.

The initial captions are generated from Inter-X source text cues rather than
category-only templates. For example, two hug clips may differ in whether A
approaches B alone, A and B walk toward each other, A uses one arm, both people
extend arms simultaneously, or the hug includes back/waist patting. These labels
are still candidates and should be checked visually before becoming gold
annotations.

## Rendering

The viewer prefers pre-rendered SMPL-X mesh MP4 videos generated from the
Inter-X SMPL-X motion parameters and local SMPL-X model files. This gives
annotators a continuous human body surface rather than a live skeleton.

The scene uses a perspective checkerboard floor. The blue figure is the
`Actor`, and the orange figure is the `Reactor`.

Caption labels are canonicalized for training: caption `A` always means the
`Actor`, and caption `B` always means the `Reactor`. The original Inter-X source
person can still be recovered from `record.roles`, for example `Caption
A=Actor/source B` means the actor is the original Inter-X person B. This avoids
training examples where the same letter sometimes means initiator and sometimes
responder.

If an SMPL-X video is missing, the app falls back to animated WebP clips in
`interactive_annotator/clips/humanoid/`, and then to the live canvas.

Regenerate SMPL-X mesh videos:

```bash
python3 tools/render_smplx_pyrender_videos.py \
  --manifest data/prototype_manifest.enriched.jsonl \
  --model-root /Users/lucas/Downloads/models_lockedhead \
  --output-dir interactive_annotator/clips/smplx_mesh
```

The renderer encodes every video frame as a keyframe so browser seeking can jump
accurately to segment boundaries. This makes the MP4 files larger, but it makes
right-panel segment replay much more reliable during annotation.

## Cloud Deployment

The current annotator is a static web app: HTML, CSS, JavaScript, JSON, and MP4
assets. It can be hosted on a private web server, S3/R2 plus CDN, or static
platforms such as Cloudflare Pages, Vercel, or Netlify.

For this project, use private access rather than a public open URL unless the
Inter-X and SMPL-X licenses explicitly allow your sharing scope. The rendered
MP4 clips are derived from Inter-X motion and SMPL-X model assets, so they
should be treated as restricted dataset artifacts.

Recommended first cloud version:

1. Upload the `interactive_annotator/` directory to a private static host.
2. Protect it with login, VPN, Basic Auth, or signed URLs.
3. Ask annotators to use `Export JSONL` and send back the exported files.
4. Merge exported JSONL files offline into the gold annotation set.

Create a static bundle:

```bash
mkdir -p releases
tar -czf releases/interactive_annotator_smplx_static.tar.gz interactive_annotator
```

For multi-user annotation with central saving, add a small backend instead of
only static hosting. The backend should store per-user annotations, lock or
assign sequences, and save review status.

## Caption Rule

Each segment should contain one concise joint caption that describes the
interaction between A and B. Do not write separate captions for A and B.

Good:

```json
{
  "start_frame": 20,
  "end_frame": 60,
  "caption": "A reaches toward B while B raises a hand to respond."
}
```

Bad:

```json
{
  "caption": "A moves."
}
```

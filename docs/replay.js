/*
 * replay.js
 *
 * Browser equivalent of the Python PerceptionReplay.
 *
 * Expected structure:
 *
 * docs/
 * ├── index.html
 * ├── replay.js
 * └── data/
 *     ├── perception.csv
 *     ├── front/
 *     │   ├── frame_000001.jpg
 *     │   └── ...
 *     ├── rear/
 *     ├── left/
 *     └── right/
 *
 * The existing dashboard must provide:
 *
 *     window.updateDashboard(payload)
 *
 * No Python.
 * No WebSocket.
 * No external libraries.
 */

(function () {

    "use strict";


    // =========================================================
    // Configuration
    // =========================================================

    const CAMERA_NAMES = [
        "front",
        "rear",
        "left",
        "right"
    ];

    const CSV_PATH = "data/perception.csv";

    const DATASET_PATH = "data";

    const TARGET_FPS = 10.0;

    const PRINT_EVERY = 50;

    // Prefetching is split into two tiers instead of one flat window.
    // A single flat window (fetch N frames ahead, all at equal priority)
    // means a *bigger* window competes for bandwidth against the frame
    // you're about to display right now -- so cranking it up can actually
    // make near-term playback slower to catch up, not faster.
    //
    // NEAR_PREFETCH_AHEAD: frames imminently needed for smooth playback.
    // Always fetched immediately, fully in parallel, on their own loop
    // that checks in frequently -- this tier is what playback actually
    // depends on and must never be starved.
    //
    // FAR_PREFETCH_AHEAD: a deeper buffer beyond that, filled in
    // opportunistically with limited concurrency (FAR_FETCH_CONCURRENCY)
    // so it can absorb network hiccups / bandwidth spikes without ever
    // crowding out the near tier. Safe to set large.
    const NEAR_PREFETCH_AHEAD = 8;

    const FAR_PREFETCH_AHEAD = 20;

    const FAR_FETCH_CONCURRENCY = 4;

    // Max number of frames' worth of decoded images kept in memory at once.
    // Bounds memory use regardless of dataset size / how long replay runs.
    const CACHE_MAX_FRAMES = 24;

    // createImageBitmap decodes off the main thread and avoids the base64
    // round-trip entirely. Fall back to the old base64 <img> path only on
    // browsers that don't support it.
    const SUPPORTS_IMAGE_BITMAP =
        typeof createImageBitmap === "function";

    // Decode each camera straight to roughly the size it's actually
    // displayed at (see index.html: hero panel ~280px tall, thumbnail
    // panels ~110px tall), doubled for screen sharpness. Source dashcam
    // frames are commonly 720p-4K; decoding (and holding in memory) at
    // full resolution when only a few hundred pixels ever get drawn is
    // what causes periodic GC stalls -- every frame allocates and frees
    // several megapixels of bitmap data for nothing. Only resizeHeight
    // is given so the browser preserves aspect ratio automatically (no
    // image distortion, and bounding-box overlays stay correct since
    // they're fraction-of-image based).
    const CAMERA_RESIZE_HEIGHT = {
        front: 560,
        left: 220,
        rear: 220,
        right: 220
    };


    // =========================================================
    // PerceptionReplay
    // =========================================================

    class PerceptionReplay {

        constructor() {

            this.csvPath = CSV_PATH;

            this.datasetPath = DATASET_PATH;

            this.targetFps = TARGET_FPS;

            this.printEvery = PRINT_EVERY;

            this.frameCount = 0;

            this.totalFrames = 0;

            this.rows = [];

            this.rowIndex = 0;

            this.running = false;

            this.timer = null;

            // frameId -> resolved { front:{bitmap|image}, rear:{...}, ... }
            // or, while a fetch is in flight, the in-flight Promise itself.
            // Storing the Promise (not just a "pending" flag) lets any
            // caller that asks for the same frame concurrently share that
            // one fetch instead of triggering a duplicate one.
            this.imageCache = new Map();

            this.nearPrefetchAhead = NEAR_PREFETCH_AHEAD;

            this.farPrefetchAhead = FAR_PREFETCH_AHEAD;

            this.farFetchConcurrency = FAR_FETCH_CONCURRENCY;

            this.cacheMax = CACHE_MAX_FRAMES;

            this.nearPrefetchRunning = false;

            this.farPrefetchRunning = false;
        }


        // =====================================================
        // Decode CSV value
        // Equivalent to Python json.loads()
        // =====================================================

        decodeCsvValue(value) {

            if (
                value === undefined ||
                value === null ||
                value === ""
            ) {
                return value;
            }

            try {

                return JSON.parse(value);

            } catch (error) {

                return value;
            }
        }


        // =====================================================
        // CSV parser
        //
        // Important:
        // Your CSV contains JSON fields with commas, therefore
        // a simple split(",") cannot be used.
        // =====================================================

        parseCsv(text) {

            const rows = [];

            let row = [];

            let field = "";

            let quoted = false;


            for (
                let i = 0;
                i < text.length;
                i++
            ) {

                const character = text[i];


                // ---------------------------------------------
                // Inside quoted CSV field
                // ---------------------------------------------

                if (quoted) {

                    if (character === '"') {

                        // CSV escaped quote:
                        // ""
                        if (
                            text[i + 1] === '"'
                        ) {

                            field += '"';

                            i++;

                        } else {

                            quoted = false;
                        }

                    } else {

                        field += character;
                    }

                    continue;
                }


                // ---------------------------------------------
                // Start quoted field
                // ---------------------------------------------

                if (
                    character === '"'
                ) {

                    quoted = true;

                }

                // ---------------------------------------------
                // Field separator
                // ---------------------------------------------

                else if (
                    character === ','
                ) {

                    row.push(field);

                    field = "";
                }

                // ---------------------------------------------
                // End of row
                // ---------------------------------------------

                else if (
                    character === '\n'
                ) {

                    row.push(field);

                    rows.push(row);

                    row = [];

                    field = "";
                }

                // ---------------------------------------------
                // Ignore CR
                // ---------------------------------------------

                else if (
                    character !== '\r'
                ) {

                    field += character;
                }
            }


            // Last row
            if (
                field.length > 0 ||
                row.length > 0
            ) {

                row.push(field);

                rows.push(row);
            }


            if (
                rows.length === 0
            ) {

                return [];
            }


            const headers = rows[0];


            return rows
                .slice(1)
                .filter(
                    values =>
                        values.some(
                            value =>
                                value !== ""
                        )
                )
                .map(values => {

                    const object = {};


                    headers.forEach(
                        (header, index) => {

                            object[header] =
                                values[index] ?? "";
                        }
                    );


                    return object;
                });
        }


        // =====================================================
        // Prepare dashboard payload
        // Equivalent to Python _prepare_payload()
        // =====================================================

        preparePayload(row) {

            const payload = {};


            // -------------------------------------------------
            // Decode every CSV field
            // -------------------------------------------------

            for (
                const [key, value]
                of Object.entries(row)
            ) {

                if (
                    value === null ||
                    value === undefined
                ) {

                    continue;
                }


                payload[key] =
                    this.decodeCsvValue(value);
            }


            // -------------------------------------------------
            // Frame ID
            // -------------------------------------------------

            let frameId =
                payload.frame_id;


            if (!frameId) {

                const frameIdx =
                    payload.frame_idx;


                if (
                    frameIdx === undefined ||
                    frameIdx === null ||
                    frameIdx === ""
                ) {

                    throw new Error(
                        "CSV row contains neither " +
                        "'frame_id' nor 'frame_idx'"
                    );
                }


                frameId =
                    "frame_" +
                    String(
                        Number(frameIdx)
                    ).padStart(
                        6,
                        "0"
                    );


                payload.frame_id =
                    frameId;
            }


            // -------------------------------------------------
            // Frame index
            // -------------------------------------------------

            if (
                payload.frame_idx ===
                undefined
            ) {

                const match =
                    String(frameId).match(
                        /(\d+)$/
                    );


                if (match) {

                    payload.frame_idx =
                        Number(match[1]);
                }
            }


            // -------------------------------------------------
            // Cameras
            // -------------------------------------------------

            let cameras =
                payload.cameras;


            if (
                !cameras ||
                typeof cameras !== "object" ||
                Array.isArray(cameras)
            ) {

                cameras = {};
            }


            // -------------------------------------------------
            // Ensure all four cameras exist
            // -------------------------------------------------

            for (
                const cameraName
                of CAMERA_NAMES
            ) {

                let cameraData =
                    cameras[cameraName];


                if (
                    !cameraData ||
                    typeof cameraData !== "object" ||
                    Array.isArray(cameraData)
                ) {

                    cameraData = {};
                }


                if (
                    !Array.isArray(
                        cameraData.boxes
                    )
                ) {

                    cameraData.boxes = [];
                }


                cameras[cameraName] =
                    cameraData;
            }


            payload.cameras =
                cameras;


            return payload;
        }


        // =====================================================
        // Load one camera image as an asset ready to draw.
        //
        // Preferred path: fetch -> Blob -> createImageBitmap.
        // This decodes off the main thread and can be handed straight
        // to canvas drawImage() with no per-frame re-decode.
        //
        // Fallback path (older browsers only): fetch -> Blob ->
        // FileReader -> base64 data URL, same as before.
        // =====================================================

        async loadCameraAsset(
            cameraName,
            frameId
        ) {

            const imagePath =
                this.datasetPath +
                "/" +
                cameraName +
                "/" +
                frameId +
                ".jpg";


            const response =
                await fetch(
                    imagePath
                );


            if (!response.ok) {

                throw new Error(
                    "Image not found: " +
                    imagePath
                );
            }


            const blob =
                await response.blob();


            if (SUPPORTS_IMAGE_BITMAP) {

                const targetHeight =
                    CAMERA_RESIZE_HEIGHT[
                        cameraName
                    ];


                const bitmap =
                    targetHeight
                        ? await createImageBitmap(
                              blob,
                              { resizeHeight: targetHeight }
                          )
                        : await createImageBitmap(
                              blob
                          );


                return { bitmap };
            }


            const dataUrl =
                await new Promise(
                    (resolve, reject) => {

                        const reader =
                            new FileReader();


                        reader.onload =
                            function () {

                                resolve(
                                    reader.result
                                );
                            };


                        reader.onerror =
                            function () {

                                reject(
                                    new Error(
                                        "Failed to read image"
                                    )
                                );
                            };


                        reader.readAsDataURL(
                            blob
                        );
                    }
                );


            const commaIndex =
                dataUrl.indexOf(",");


            return {
                image:
                    commaIndex >= 0
                        ? dataUrl.substring(commaIndex + 1)
                        : dataUrl
            };
        }


        // =====================================================
        // Load all four camera assets for one frame
        // =====================================================

        async loadFrameAssets(frameId) {

            const entries =
                await Promise.all(

                    CAMERA_NAMES.map(
                        async cameraName => [
                            cameraName,
                            await this.loadCameraAsset(
                                cameraName,
                                frameId
                            )
                        ]
                    )
                );


            const assets = {};

            for (
                const [name, asset]
                of entries
            ) {

                assets[name] = asset;
            }


            return assets;
        }


        // =====================================================
        // Cache helpers
        // =====================================================

        // Cheaply derive a frame's id from its row without running full
        // preparePayload() -- used by the prefetcher to know what to
        // fetch next.
        peekFrameId(index) {

            const row =
                this.rows[index];


            if (!row) return null;


            let frameId =
                this.decodeCsvValue(
                    row.frame_id
                );


            if (!frameId) {

                const frameIdx =
                    this.decodeCsvValue(
                        row.frame_idx
                    );


                if (
                    frameIdx === undefined ||
                    frameIdx === null ||
                    frameIdx === ""
                ) {

                    return null;
                }


                frameId =
                    "frame_" +
                    String(
                        Number(frameIdx)
                    ).padStart(6, "0");
            }


            return frameId;
        }


        // Get this frame's camera assets, sharing an in-flight fetch with
        // any other caller (near tier, far tier, playback loop) asking
        // for the same frame at the same time, instead of double-fetching
        // it.
        getOrLoadFrameAssets(frameId) {

            const entry =
                this.imageCache.get(
                    frameId
                );


            if (entry) {

                // Already resolved -> wrap in a Promise.
                // Still loading -> entry IS the Promise; return it as-is
                // so the caller awaits the same fetch.
                return typeof entry.then === "function"
                    ? entry
                    : Promise.resolve(entry);
            }


            const loadPromise =
                this.loadFrameAssets(frameId)
                    .then(assets => {

                        this.imageCache.set(
                            frameId,
                            assets
                        );

                        return assets;
                    })
                    .catch(error => {

                        this.imageCache.delete(
                            frameId
                        );

                        throw error;
                    });


            this.imageCache.set(
                frameId,
                loadPromise
            );


            return loadPromise;
        }


        // Release an entry's decoded bitmaps and drop it from the cache.
        // No-ops on entries that are still in-flight Promises -- those
        // will simply be considered for eviction again on a later pass
        // once they've resolved.
        evictFrame(frameId) {

            const entry =
                this.imageCache.get(
                    frameId
                );


            if (!entry) return;


            if (
                typeof entry.then
                    === "function"
            ) {

                return;
            }


            this.imageCache.delete(
                frameId
            );


            for (
                const cameraName
                of CAMERA_NAMES
            ) {

                const asset =
                    entry[cameraName];


                if (
                    asset &&
                    asset.bitmap &&
                    typeof asset.bitmap.close
                        === "function"
                ) {

                    asset.bitmap.close();
                }
            }
        }


        // Trim the cache down to cacheMax, never evicting anything in
        // `keepFrameIds` (the current near+far prefetch window).
        pruneCache(keepFrameIds) {

            if (
                this.imageCache.size
                <= this.cacheMax
            ) {

                return;
            }


            for (
                const frameId
                of this.imageCache.keys()
            ) {

                if (
                    this.imageCache.size
                    <= this.cacheMax
                ) {

                    break;
                }


                if (
                    keepFrameIds.has(frameId)
                ) {

                    continue;
                }


                this.evictFrame(frameId);
            }
        }


        // Frame ids for the next `count` frames from the playhead,
        // wrapping at the end of the dataset. Shared helper for both
        // prefetch tiers so their windows are always defined the same
        // way relative to this.rowIndex.
        upcomingFrameIds(startOffset, count) {

            const ids = [];


            if (this.totalFrames <= 0) return ids;


            for (
                let offset = startOffset;
                offset < startOffset + count;
                offset++
            ) {

                const idx =
                    (this.rowIndex + offset)
                    % this.totalFrames;


                const frameId =
                    this.peekFrameId(idx);


                if (frameId) ids.push(frameId);
            }


            return ids;
        }


        // =====================================================
        // Near-tier prefetcher
        //
        // Keeps the next `nearPrefetchAhead` frames decoded and ready,
        // fetched fully in parallel every cycle. This is the tier
        // playback actually depends on for smoothness, so it always
        // gets first call on bandwidth and is never gated behind the
        // (much larger) far tier.
        // =====================================================

        async runNearPrefetcher() {

            if (this.nearPrefetchRunning) return;

            this.nearPrefetchRunning = true;


            while (
                this.running &&
                this.totalFrames > 0
            ) {

                const nearIds =
                    this.upcomingFrameIds(
                        0,
                        this.nearPrefetchAhead
                    );


                await Promise.allSettled(

                    nearIds.map(frameId =>
                        this.getOrLoadFrameAssets(
                            frameId
                        ).catch(error => {

                            console.warn(
                                "[PerceptionReplay] " +
                                "Near prefetch failed for " +
                                frameId,
                                error
                            );
                        })
                    )
                );


                if (!this.running) break;


                // Check back in quickly -- this tier needs to react as
                // soon as the playhead advances.
                await new Promise(
                    resolve => setTimeout(resolve, 16)
                );
            }


            this.nearPrefetchRunning = false;
        }


        // =====================================================
        // Far-tier prefetcher
        //
        // Fills the deeper buffer (frames beyond the near tier, out to
        // farPrefetchAhead) opportunistically, in small concurrency-
        // limited batches, so it can build up a large resilience buffer
        // without ever flooding the connection and starving the near
        // tier above. Also owns cache pruning, since it's the one that
        // knows the full near+far window.
        // =====================================================

        async runFarPrefetcher() {

            if (this.farPrefetchRunning) return;

            this.farPrefetchRunning = true;


            while (
                this.running &&
                this.totalFrames > 0
            ) {

                const nearIds =
                    this.upcomingFrameIds(
                        0,
                        this.nearPrefetchAhead
                    );

                const farIds =
                    this.upcomingFrameIds(
                        this.nearPrefetchAhead,
                        Math.max(
                            0,
                            this.farPrefetchAhead
                                - this.nearPrefetchAhead
                        )
                    );


                const keep =
                    new Set([...nearIds, ...farIds]);


                for (
                    let i = 0;
                    i < farIds.length;
                    i += this.farFetchConcurrency
                ) {

                    if (!this.running) break;


                    const batch =
                        farIds.slice(
                            i,
                            i + this.farFetchConcurrency
                        );


                    await Promise.allSettled(

                        batch.map(frameId =>
                            this.getOrLoadFrameAssets(
                                frameId
                            ).catch(error => {

                                console.warn(
                                    "[PerceptionReplay] " +
                                    "Far prefetch failed for " +
                                    frameId,
                                    error
                                );
                            })
                        )
                    );
                }


                this.pruneCache(keep);


                await new Promise(
                    resolve => setTimeout(resolve, 50)
                );
            }


            this.farPrefetchRunning = false;
        }


        // =====================================================
        // Load CSV
        // Equivalent to _get_total_frames()
        // =====================================================

        async loadCsv() {

            console.log(
                "[PerceptionReplay] " +
                "Loading CSV..."
            );


            const response =
                await fetch(
                    this.csvPath,
                    {
                        cache: "no-store"
                    }
                );


            if (!response.ok) {

                throw new Error(
                    "CSV not found: " +
                    this.csvPath
                );
            }


            const csvText =
                await response.text();


            this.rows =
                this.parseCsv(
                    csvText
                );


            this.totalFrames =
                this.rows.length;


            if (
                this.totalFrames === 0
            ) {

                throw new Error(
                    "CSV contains no data rows."
                );
            }


            console.log(
                "[PerceptionReplay] " +
                "CSV loaded: " +
                this.totalFrames +
                " frames"
            );
        }


        // =====================================================
        // Publish one frame
        // =====================================================

        async publishFrame() {

            if (
                !this.rows.length
            ) {

                return;
            }


            const row =
                this.rows[
                    this.rowIndex
                ];


            // -------------------------------------------------
            // Build payload
            // -------------------------------------------------

            let payload =
                this.preparePayload(
                    row
                );


            // -------------------------------------------------
            // Grab this frame's camera images. Normally this is
            // already warm from the near-tier prefetcher; on a cache
            // miss (e.g. frame 0, before the prefetchers have gotten
            // anywhere) or while a fetch for this exact frame is still
            // in flight, this awaits that SAME fetch rather than
            // starting a second, duplicate one.
            // -------------------------------------------------

            const frameId =
                payload.frame_id;


            const assets =
                await this.getOrLoadFrameAssets(
                    frameId
                );


            for (
                const cameraName
                of CAMERA_NAMES
            ) {

                Object.assign(
                    payload.cameras[cameraName],
                    assets[cameraName]
                );
            }


            // -------------------------------------------------
            // Reset trajectory at start of replay
            // -------------------------------------------------

            if (
                this.rowIndex === 0
            ) {

                payload.trajectory_reset =
                    true;
            }


            // -------------------------------------------------
            // Push to existing dashboard
            // -------------------------------------------------

            if (
                typeof window.updateDashboard
                !== "function"
            ) {

                throw new Error(
                    "updateDashboard() " +
                    "was not found in dashboard."
                );
            }


            window.updateDashboard(
                payload
            );


            // -------------------------------------------------
            // Count
            // -------------------------------------------------

            this.frameCount++;


            // -------------------------------------------------
            // Progress
            // -------------------------------------------------

            if (
                this.printEvery > 0 &&
                this.frameCount %
                    this.printEvery === 0
            ) {

                console.log(
                    "[PerceptionReplay] " +
                    "Published " +
                    this.frameCount +
                    " frames " +
                    "(current: " +
                    payload.frame_id +
                    ")"
                );
            }


            // -------------------------------------------------
            // Next CSV row
            // -------------------------------------------------

            this.rowIndex++;


            // -------------------------------------------------
            // Replay finished
            // -------------------------------------------------

            if (
                this.rowIndex >=
                this.totalFrames
            ) {

                console.log(
                    "[PerceptionReplay] " +
                    "Replay complete: " +
                    this.frameCount +
                    " frames published."
                );


                // Restart from frame 1
                this.rowIndex = 0;

                this.frameCount = 0;
            }
        }


        // =====================================================
        // Start continuous replay
        // =====================================================

        async replay() {

            if (
                this.running
            ) {

                return;
            }


            this.running = true;


            console.log(
                "[PerceptionReplay] " +
                "Starting replay..."
            );


            console.log(
                "[PerceptionReplay] " +
                "Target FPS: " +
                this.targetFps
            );


            await this.loadCsv();


            // -------------------------------------------------
            // Reset replay state
            // -------------------------------------------------

            this.rowIndex = 0;

            this.frameCount = 0;


            // -------------------------------------------------
            // Start background prefetching. Both tiers run
            // concurrently with the playback loop below so image
            // decoding happens ahead of when each frame is actually
            // needed -- the near tier keeps playback smooth, the far
            // tier opportunistically builds up a deeper resilience
            // buffer without competing with it.
            // -------------------------------------------------

            this.runNearPrefetcher();

            this.runFarPrefetcher();


            // -------------------------------------------------
            // Tell dashboard total frame count
            // -------------------------------------------------

            if (
                typeof window.updateDashboard
                === "function"
            ) {

                window.updateDashboard({

                    trajectory_reset: true,

                    replay_total_frames:
                        this.totalFrames
                });
            }


            const framePeriod =
                this.targetFps > 0
                    ? 1000 /
                      this.targetFps
                    : 0;


            // -------------------------------------------------
            // Replay loop
            // -------------------------------------------------

            const loop =
                async () => {

                    if (
                        !this.running
                    ) {

                        return;
                    }


                    const startTime =
                        performance.now();


                    try {

                        await this.publishFrame();

                    } catch (error) {

                        console.error(
                            "[PerceptionReplay]",
                            error
                        );


                        this.stop();

                        return;
                    }


                    if (
                        !this.running
                    ) {

                        return;
                    }


                    // Maximum speed
                    if (
                        framePeriod <= 0
                    ) {

                        this.timer =
                            setTimeout(
                                loop,
                                0
                            );

                        return;
                    }


                    // -------------------------------------------------
                    // Maintain target FPS
                    // -------------------------------------------------

                    const elapsed =
                        performance.now() -
                        startTime;


                    const delay =
                        Math.max(
                            0,
                            framePeriod -
                            elapsed
                        );


                    this.timer =
                        setTimeout(
                            loop,
                            delay
                        );
                };


            loop();
        }


        // =====================================================
        // Stop replay
        // =====================================================

        stop() {

            this.running =
                false;


            if (
                this.timer !== null
            ) {

                clearTimeout(
                    this.timer
                );


                this.timer =
                    null;
            }


            console.log(
                "[PerceptionReplay] " +
                "Replay stopped."
            );
        }
    }


    // =========================================================
    // Make class accessible globally
    // =========================================================

    window.PerceptionReplay =
        PerceptionReplay;


    // =========================================================
    // Automatically start when dashboard loads
    // =========================================================

    window.addEventListener(
        "load",
        function () {

            const replay =
                new PerceptionReplay();


            window.perceptionReplay =
                replay;


            replay.replay();
        }
    );

})();
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

    // How many frames ahead of the playhead to decode in the background.
    // This is what hides network/decode latency behind playback time instead
    // of blocking each frame -- it's the fix for the "slow on first loop"
    // symptom (nothing was ever pre-loaded before, so every frame stalled on
    // a cold fetch).
    const PREFETCH_AHEAD = 8;

    // Max number of frames' worth of decoded images kept in memory at once.
    // Bounds memory use regardless of dataset size / how long replay runs.
    const CACHE_MAX_FRAMES = 16;

    // createImageBitmap decodes off the main thread and avoids the base64
    // round-trip entirely. Fall back to the old base64 <img> path only on
    // browsers that don't support it.
    const SUPPORTS_IMAGE_BITMAP =
        typeof createImageBitmap === "function";


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

            // frameId -> { front:{bitmap|image}, rear:{...}, left:{...}, right:{...} }
            // or the sentinel string "pending" while a fetch is in flight.
            this.imageCache = new Map();

            this.prefetchAhead = PREFETCH_AHEAD;

            this.cacheMax = CACHE_MAX_FRAMES;

            this.prefetchRunning = false;
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

                const bitmap =
                    await createImageBitmap(
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


        // Release an entry's decoded bitmaps and drop it from the cache.
        evictFrame(frameId) {

            const assets =
                this.imageCache.get(
                    frameId
                );


            this.imageCache.delete(
                frameId
            );


            if (
                !assets ||
                assets === "pending"
            ) {

                return;
            }


            for (
                const cameraName
                of CAMERA_NAMES
            ) {

                const asset =
                    assets[cameraName];


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
        // `keepFrameIds` (the current prefetch window).
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


        // =====================================================
        // Background prefetcher
        //
        // Keeps a rolling window of `prefetchAhead` frames (relative to
        // the current playhead, wrapping at the end of the dataset)
        // decoded and ready in this.imageCache. Runs concurrently with
        // the playback loop so publishFrame() essentially never has to
        // wait on the network once the window has filled in.
        // =====================================================

        async runPrefetcher() {

            if (this.prefetchRunning) return;

            this.prefetchRunning = true;


            while (
                this.running &&
                this.totalFrames > 0
            ) {

                const keep = new Set();


                for (
                    let offset = 0;
                    offset < this.prefetchAhead;
                    offset++
                ) {

                    if (!this.running) break;


                    const idx =
                        (this.rowIndex + offset)
                        % this.totalFrames;


                    const frameId =
                        this.peekFrameId(idx);


                    if (!frameId) continue;


                    keep.add(frameId);


                    if (
                        this.imageCache.has(
                            frameId
                        )
                    ) {

                        continue;
                    }


                    this.imageCache.set(
                        frameId,
                        "pending"
                    );


                    try {

                        const assets =
                            await this.loadFrameAssets(
                                frameId
                            );


                        if (!this.running) {

                            // Replay was stopped mid-fetch: release
                            // what we just decoded instead of caching it.
                            for (
                                const cameraName
                                of CAMERA_NAMES
                            ) {

                                const a =
                                    assets[cameraName];


                                if (
                                    a &&
                                    a.bitmap &&
                                    typeof a.bitmap.close
                                        === "function"
                                ) {

                                    a.bitmap.close();
                                }
                            }


                            this.imageCache.delete(
                                frameId
                            );

                            break;
                        }


                        this.imageCache.set(
                            frameId,
                            assets
                        );

                    } catch (error) {

                        this.imageCache.delete(
                            frameId
                        );


                        console.warn(
                            "[PerceptionReplay] " +
                            "Prefetch failed for " +
                            frameId,
                            error
                        );
                    }
                }


                this.pruneCache(keep);


                // Yield briefly once the window is filled so this loop
                // doesn't spin; it wakes up again as soon as rowIndex
                // advances and there's new work to do.
                await new Promise(
                    resolve => setTimeout(resolve, 16)
                );
            }


            this.prefetchRunning = false;
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
            // Grab this frame's camera images from the prefetch
            // cache (should already be warm); fall back to a
            // direct load on a cache miss so playback never
            // deadlocks (e.g. the very first frame, before the
            // prefetcher has had a chance to run).
            // -------------------------------------------------

            const frameId =
                payload.frame_id;


            let assets =
                this.imageCache.get(
                    frameId
                );


            if (
                !assets ||
                assets === "pending"
            ) {

                assets =
                    await this.loadFrameAssets(
                        frameId
                    );


                this.imageCache.set(
                    frameId,
                    assets
                );
            }


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
            // Start background prefetching. Runs concurrently with
            // the playback loop below so image decoding happens
            // ahead of when each frame is actually needed.
            // -------------------------------------------------

            this.runPrefetcher();


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
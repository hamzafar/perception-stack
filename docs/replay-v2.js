/*
 * replay.js
 * ============================================================
 * Browser-based equivalent of Python PerceptionReplay.
 *
 * Data:
 *
 *   data/perception.csv
 *   data/front/frame_000001.jpg
 *   data/rear/frame_000001.jpg
 *   data/left/frame_000001.jpg
 *   data/right/frame_000001.jpg
 *
 * Dashboard:
 *
 *   window.updateDashboard(payload)
 *
 * Features:
 *   - CSV replay
 *   - 10 FPS target
 *   - 40-frame look-ahead preload
 *   - rolling image cache
 *   - automatic looping
 *   - trajectory reset
 *   - replay progress
 *   - logging every 50 frames
 *   - no external libraries
 * ============================================================
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

    const CSV_PATH =
        "data/perception.csv";

    const DATASET_PATH =
        "data";

    const TARGET_FPS =
        10.0;

    const PRINT_EVERY =
        50;

    /*
     * Number of future frames to preload.
     *
     * 40 frames at 10 FPS = 4 seconds
     * of look-ahead.
     */
    const PRELOAD_AHEAD =
        20;

    /*
     * Number of previous frames to keep.
     *
     * This prevents the JavaScript cache from
     * growing indefinitely.
     */
    const CACHE_BEHIND =
        5;


    // =========================================================
    // PerceptionReplay
    // =========================================================

    class PerceptionReplay {

        constructor() {

            this.csvPath =
                CSV_PATH;

            this.datasetPath =
                DATASET_PATH;

            this.targetFps =
                TARGET_FPS;

            this.printEvery =
                PRINT_EVERY;

            this.preloadAhead =
                PRELOAD_AHEAD;

            this.cacheBehind =
                CACHE_BEHIND;


            // -------------------------------------------------
            // Replay state
            // -------------------------------------------------

            this.rows = [];

            this.totalFrames =
                0;

            this.rowIndex =
                0;

            this.frameCount =
                0;

            this.running =
                false;

            this.timer =
                null;


            // -------------------------------------------------
            // Rolling image cache
            //
            // key:
            //
            //     front/frame_000001
            //
            // value:
            //
            //     Promise -> Base64 JPEG
            //
            // IMPORTANT:
            // This cache is deliberately bounded.
            // -------------------------------------------------

            this.imageCache =
                new Map();


            /*
             * Tracks frame indices whose preload
             * operation has already been scheduled.
             */
            this.preloadingIndexes =
                new Set();
        }


        // =====================================================
        // Decode CSV value
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

                return JSON.parse(
                    value
                );

            } catch (error) {

                return value;
            }
        }


        // =====================================================
        // CSV parser
        //
        // Supports quoted JSON containing commas.
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

                const character =
                    text[i];


                // -------------------------------------------------
                // Inside quoted field
                // -------------------------------------------------

                if (quoted) {

                    if (
                        character === '"'
                    ) {

                        /*
                         * CSV escaped quote:
                         *
                         * ""
                         */
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


                // -------------------------------------------------
                // Start quoted field
                // -------------------------------------------------

                if (
                    character === '"'
                ) {

                    quoted = true;

                }

                // -------------------------------------------------
                // Field separator
                // -------------------------------------------------

                else if (
                    character === ","
                ) {

                    row.push(
                        field
                    );

                    field = "";
                }

                // -------------------------------------------------
                // End of row
                // -------------------------------------------------

                else if (
                    character === "\n"
                ) {

                    row.push(
                        field
                    );

                    rows.push(
                        row
                    );

                    row = [];

                    field = "";
                }

                // -------------------------------------------------
                // Ignore CR
                // -------------------------------------------------

                else if (
                    character !== "\r"
                ) {

                    field += character;
                }
            }


            // -------------------------------------------------
            // Last row
            // -------------------------------------------------

            if (
                field.length > 0 ||
                row.length > 0
            ) {

                row.push(
                    field
                );

                rows.push(
                    row
                );
            }


            if (
                rows.length === 0
            ) {

                return [];
            }


            const headers =
                rows[0];


            return rows
                .slice(1)
                .filter(
                    values =>
                        values.some(
                            value =>
                                value !== ""
                        )
                )
                .map(
                    values => {

                        const object = {};


                        headers.forEach(
                            (
                                header,
                                index
                            ) => {

                                object[header] =
                                    values[index] ??
                                    "";
                            }
                        );


                        return object;
                    }
                );
        }


        // =====================================================
        // Prepare dashboard payload
        // =====================================================

        preparePayload(row) {

            const payload = {};


            // -------------------------------------------------
            // Decode CSV fields
            // -------------------------------------------------

            for (
                const [
                    key,
                    value
                ]
                of Object.entries(row)
            ) {

                if (
                    value === null ||
                    value === undefined
                ) {

                    continue;
                }


                payload[key] =
                    this.decodeCsvValue(
                        value
                    );
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
                    String(
                        frameId
                    ).match(
                        /(\d+)$/
                    );


                if (match) {

                    payload.frame_idx =
                        Number(
                            match[1]
                        );
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
            // Ensure all cameras exist
            // -------------------------------------------------

            for (
                const cameraName
                of CAMERA_NAMES
            ) {

                let cameraData =
                    cameras[
                        cameraName
                    ];


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


                cameras[
                    cameraName
                ] =
                    cameraData;
            }


            payload.cameras =
                cameras;


            return payload;
        }


        // =====================================================
        // Load one JPEG as Base64
        //
        // The Promise itself is stored in the cache.
        //
        // This means preload + playback share the same
        // request instead of downloading the same image twice.
        // =====================================================

        async loadImageBase64(
            cameraName,
            frameId
        ) {

            const cacheKey =
                cameraName +
                "/" +
                frameId;


            // -------------------------------------------------
            // Cache hit
            // -------------------------------------------------

            if (
                this.imageCache.has(
                    cacheKey
                )
            ) {

                return this.imageCache.get(
                    cacheKey
                );
            }


            // -------------------------------------------------
            // Image path
            // -------------------------------------------------

            const imagePath =
                this.datasetPath +
                "/" +
                cameraName +
                "/" +
                frameId +
                ".jpg";


            // -------------------------------------------------
            // Start network request
            // -------------------------------------------------

            const imagePromise =
                fetch(
                    imagePath,
                    {
                        cache:
                            "force-cache"
                    }
                )
                .then(
                    response => {

                        if (
                            !response.ok
                        ) {

                            throw new Error(
                                "Image not found: " +
                                imagePath
                            );
                        }


                        return response.blob();
                    }
                )
                .then(
                    blob => {

                        return new Promise(
                            (
                                resolve,
                                reject
                            ) => {

                                const reader =
                                    new FileReader();


                                reader.onload =
                                    () => {

                                        const result =
                                            reader.result;


                                        const commaIndex =
                                            result.indexOf(
                                                ","
                                            );


                                        resolve(
                                            commaIndex >= 0
                                                ? result.slice(
                                                    commaIndex + 1
                                                )
                                                : result
                                        );
                                    };


                                reader.onerror =
                                    () => {

                                        reject(
                                            reader.error ||
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
                    }
                );


            /*
             * Store immediately.
             *
             * A second caller gets the same Promise.
             */
            this.imageCache.set(
                cacheKey,
                imagePromise
            );


            try {

                return await imagePromise;

            } catch (error) {

                /*
                 * Remove failed requests so they
                 * can be retried.
                 */
                this.imageCache.delete(
                    cacheKey
                );

                throw error;
            }
        }


        // =====================================================
        // Load all four camera images
        // =====================================================

        async prepareImages(
            payload
        ) {

            const frameId =
                payload.frame_id;


            await Promise.all(

                CAMERA_NAMES.map(
                    async cameraName => {

                        payload
                            .cameras
                            [cameraName]
                            .image =

                            await this.loadImageBase64(
                                cameraName,
                                frameId
                            );
                    }
                )
            );


            return payload;
        }


        // =====================================================
        // Preload future frames
        //
        // This is background work.
        // Playback does NOT wait for the entire preload.
        // =====================================================

        async preloadFrames(
            startIndex
        ) {

            if (
                !this.totalFrames
            ) {

                return;
            }


            const endIndex =
                Math.min(
                    startIndex +
                    this.preloadAhead,

                    this.totalFrames
                );


            const jobs = [];


            for (
                let index = startIndex;
                index < endIndex;
                index++
            ) {

                /*
                 * Don't schedule the same frame repeatedly.
                 */
                if (
                    this.preloadingIndexes.has(
                        index
                    )
                ) {

                    continue;
                }


                this.preloadingIndexes.add(
                    index
                );


                try {

                    const payload =
                        this.preparePayload(
                            this.rows[
                                index
                            ]
                        );


                    const frameId =
                        payload.frame_id;


                    // -----------------------------------------
                    // Four cameras
                    // -----------------------------------------

                    for (
                        const cameraName
                        of CAMERA_NAMES
                    ) {

                        jobs.push(
                            this.loadImageBase64(
                                cameraName,
                                frameId
                            )
                        );
                    }

                } catch (error) {

                    console.warn(
                        "[PerceptionReplay] " +
                        "Preload preparation failed:",
                        error
                    );
                }
            }


            if (
                jobs.length > 0
            ) {

                /*
                 * Don't await from the replay loop.
                 */
                Promise.allSettled(
                    jobs
                );
            }
        }


        // =====================================================
        // Rolling cache cleanup
        //
        // Keeps:
        //
        //   current - 5
        //   through
        //   current + 40
        //
        // Everything else is removed from our JS cache.
        // =====================================================

        cleanupCache(
            currentIndex
        ) {

            const minIndex =
                Math.max(
                    0,
                    currentIndex -
                    this.cacheBehind
                );


            const maxIndex =
                Math.min(
                    this.totalFrames - 1,
                    currentIndex +
                    this.preloadAhead
                );


            // -------------------------------------------------
            // Remove old image cache entries
            // -------------------------------------------------

            for (
                const key
                of this.imageCache.keys()
            ) {

                const match =
                    key.match(
                        /\/frame_(\d+)$/
                    );


                if (!match) {
                    continue;
                }


                const frameNumber =
                    Number(
                        match[1]
                    );


                /*
                 * frame_000001 corresponds
                 * to array index 0.
                 */
                const frameIndex =
                    frameNumber - 1;


                if (
                    frameIndex < minIndex ||
                    frameIndex > maxIndex
                ) {

                    this.imageCache.delete(
                        key
                    );
                }
            }


            // -------------------------------------------------
            // Keep preload bookkeeping bounded too
            // -------------------------------------------------

            for (
                const index
                of this.preloadingIndexes
            ) {

                if (
                    index < minIndex ||
                    index > maxIndex
                ) {

                    this.preloadingIndexes.delete(
                        index
                    );
                }
            }
        }


        // =====================================================
        // Load CSV
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
                        cache:
                            "no-store"
                    }
                );


            if (
                !response.ok
            ) {

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


            // -------------------------------------------------
            // Current row
            // -------------------------------------------------

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
            // Get four images
            //
            // Usually cache hits after preloading starts.
            // -------------------------------------------------

            payload =
                await this.prepareImages(
                    payload
                );


            // -------------------------------------------------
            // Reset trajectory at beginning of replay
            // -------------------------------------------------

            if (
                this.rowIndex === 0
            ) {

                payload.trajectory_reset =
                    true;
            }


            // -------------------------------------------------
            // Send to existing dashboard
            // -------------------------------------------------

            if (
                typeof window.updateDashboard !==
                "function"
            ) {

                throw new Error(
                    "updateDashboard() " +
                    "was not found."
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
            // Progress logging
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
            // Move forward
            // -------------------------------------------------

            this.rowIndex++;


            // -------------------------------------------------
            // Rolling cache cleanup
            // -------------------------------------------------

            this.cleanupCache(
                this.rowIndex
            );


            // -------------------------------------------------
            // Start next preload window
            // -------------------------------------------------

            if (
                this.rowIndex <
                this.totalFrames
            ) {

                this.preloadFrames(
                    this.rowIndex
                );
            }


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


                /*
                 * Restart.
                 */
                this.rowIndex =
                    0;

                this.frameCount =
                    0;


                /*
                 * Reset the rolling cache around
                 * the beginning of the dataset.
                 */
                this.cleanupCache(
                    0
                );


                /*
                 * Allow the first frames to be
                 * preloaded again.
                 */
                this.preloadingIndexes.clear();


                this.preloadFrames(
                    0
                );
            }
        }


        // =====================================================
        // Start replay
        // =====================================================

        async replay() {

            if (
                this.running
            ) {

                return;
            }


            this.running =
                true;


            console.log(
                "[PerceptionReplay] " +
                "Starting replay..."
            );


            console.log(
                "[PerceptionReplay] " +
                "Target FPS: " +
                this.targetFps
            );


            console.log(
                "[PerceptionReplay] " +
                "Preload ahead: " +
                this.preloadAhead +
                " frames"
            );


            console.log(
                "[PerceptionReplay] " +
                "Cache behind: " +
                this.cacheBehind +
                " frames"
            );


            // -------------------------------------------------
            // Load CSV
            // -------------------------------------------------

            await this.loadCsv();


            // -------------------------------------------------
            // Reset replay state
            // -------------------------------------------------

            this.rowIndex =
                0;

            this.frameCount =
                0;


            this.imageCache.clear();

            this.preloadingIndexes.clear();


            // -------------------------------------------------
            // Inform dashboard
            // -------------------------------------------------

            if (
                typeof window.updateDashboard
                === "function"
            ) {

                window.updateDashboard({

                    trajectory_reset:
                        true,

                    replay_total_frames:
                        this.totalFrames
                });
            }


            // -------------------------------------------------
            // Start background preload
            //
            // IMPORTANT:
            // Do not await it.
            // -------------------------------------------------

            this.preloadFrames(
                0
            );


            // -------------------------------------------------
            // FPS timing
            // -------------------------------------------------

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


                    // -------------------------------------------------
                    // Maximum-speed mode
                    // -------------------------------------------------

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
    // Expose globally
    // =========================================================

    window.PerceptionReplay =
        PerceptionReplay;


    // =========================================================
    // Automatic startup
    // =========================================================

    window.addEventListener(
        "load",
        () => {

            const replay =
                new PerceptionReplay();


            window.perceptionReplay =
                replay;


            replay.replay();
        }
    );

})();
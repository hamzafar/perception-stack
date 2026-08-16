/*
 * replay.js
 *
 * ROLLING WINDOW REPLAY
 *
 * Architecture:
 *
 *   Initial buffer:
 *       20 frames
 *       × 4 cameras
 *       = 80 images
 *
 *   Playback:
 *       10 FPS
 *
 *   Background:
 *       Continuously prepares future frames
 *
 *   Cache:
 *       Bounded to approximately 20 frames
 *
 * Images:
 *       400x300
 *       Native Image()
 *       img.decode()
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
        "data_400x300";


    const TARGET_FPS =
        10.0;


    const PRINT_EVERY =
        50;


    // ---------------------------------------------------------
    // Rolling window size
    //
    // At 10 FPS:
    //
    // 20 frames = 2 seconds of buffer
    //
    // 20 frames × 4 cameras = 80 images
    // ---------------------------------------------------------

    const ROLLING_WINDOW_FRAMES =
        20;


    // ---------------------------------------------------------
    // Number of COMPLETE frames loaded concurrently.
    //
    // 4 frames × 4 cameras
    // = 16 image loads concurrently
    // ---------------------------------------------------------

    const FRAME_LOAD_CONCURRENCY =
        8;


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


            this.rows =
                [];

            this.totalFrames =
                0;


            // Current replay position.
            this.rowIndex =
                0;


            this.frameCount =
                0;


            this.running =
                false;


            this.timer =
                null;


            // -------------------------------------------------
            // frameId -> camera assets
            //
            // Only the rolling window should remain here.
            // -------------------------------------------------

            this.imageCache =
                new Map();


            // -------------------------------------------------
            // frameId -> Promise
            //
            // Prevents duplicate loading.
            // -------------------------------------------------

            this.loading =
                new Map();


            // -------------------------------------------------
            // Prevent multiple rolling loaders.
            // -------------------------------------------------

            this.loaderRunning =
                false;
        }


        // =====================================================
        // CSV value decoder
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

            } catch (_) {

                return value;
            }
        }


        // =====================================================
        // CSV parser
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

                const ch =
                    text[i];


                if (quoted) {

                    if (ch === '"') {

                        if (
                            text[i + 1] === '"'
                        ) {

                            field += '"';

                            i++;

                        } else {

                            quoted =
                                false;
                        }

                    } else {

                        field += ch;
                    }

                    continue;
                }


                if (ch === '"') {

                    quoted =
                        true;

                } else if (
                    ch === ","
                ) {

                    row.push(
                        field
                    );

                    field =
                        "";

                } else if (
                    ch === "\n"
                ) {

                    row.push(
                        field
                    );

                    rows.push(
                        row
                    );

                    row =
                        [];

                    field =
                        "";

                } else if (
                    ch !== "\r"
                ) {

                    field += ch;
                }
            }


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

                        const object =
                            {};

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

            const payload =
                {};


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

                cameras =
                    {};
            }


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

                    cameraData =
                        {};
                }


                if (
                    !Array.isArray(
                        cameraData.boxes
                    )
                ) {

                    cameraData.boxes =
                        [];
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
        // Get frame ID from CSV index
        // =====================================================

        getFrameId(index) {

            if (
                this.totalFrames <= 0
            ) {

                return null;
            }


            // -------------------------------------------------
            // Wrap around for replay looping.
            // -------------------------------------------------

            index =
                (
                    index %
                    this.totalFrames +
                    this.totalFrames
                ) %
                this.totalFrames;


            const row =
                this.rows[index];


            if (!row) {

                return null;
            }


            let frameId =
                this.decodeCsvValue(
                    row.frame_id
                );


            if (frameId) {

                return String(
                    frameId
                );
            }


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


            return (
                "frame_" +
                String(
                    Number(frameIdx)
                ).padStart(
                    6,
                    "0"
                )
            );
        }


        // =====================================================
        // Load ONE native image
        // =====================================================

        loadNativeImage(
            cameraName,
            frameId
        ) {

            return new Promise(
                (resolve, reject) => {

                    const image =
                        new Image();


                    image.decoding =
                        "async";


                    image.onload =
                        async () => {

                            try {

                                if (
                                    typeof image.decode ===
                                    "function"
                                ) {

                                    try {

                                        await image.decode();

                                    } catch (_) {

                                        // The image has already
                                        // loaded and is usable.
                                    }
                                }


                                resolve({

                                    bitmap:
                                        image
                                });


                            } catch (error) {

                                reject(
                                    error
                                );
                            }
                        };


                    image.onerror =
                        () => {

                            reject(
                                new Error(
                                    "Image failed: " +
                                    cameraName +
                                    "/" +
                                    frameId +
                                    ".jpg"
                                )
                            );
                        };


                    image.src =
                        this.datasetPath +
                        "/" +
                        cameraName +
                        "/" +
                        frameId +
                        ".jpg";
                }
            );
        }


        // =====================================================
        // Load all four cameras for one frame
        // =====================================================

        async loadFrameAssets(
            frameId
        ) {

            const assets =
                {};


            const results =
                await Promise.allSettled(

                    CAMERA_NAMES.map(
                        cameraName =>
                            this.loadNativeImage(
                                cameraName,
                                frameId
                            )
                    )
                );


            results.forEach(
                (
                    result,
                    index
                ) => {

                    const cameraName =
                        CAMERA_NAMES[
                            index
                        ];


                    if (
                        result.status ===
                        "fulfilled"
                    ) {

                        assets[
                            cameraName
                        ] =
                            result.value;

                    } else {

                        console.error(
                            "[BUFFER] Failed:",
                            cameraName,
                            frameId,
                            result.reason
                        );


                        assets[
                            cameraName
                        ] =
                            {};
                    }
                }
            );


            return assets;
        }


        // =====================================================
        // Load one complete frame
        // =====================================================

        loadFrame(
            frameId
        ) {

            // Already cached.
            if (
                this.imageCache.has(
                    frameId
                )
            ) {

                return Promise.resolve(
                    this.imageCache.get(
                        frameId
                    )
                );
            }


            // Already being loaded.
            if (
                this.loading.has(
                    frameId
                )
            ) {

                return this.loading.get(
                    frameId
                );
            }


            const promise =
                this.loadFrameAssets(
                    frameId
                )
                .then(
                    assets => {

                        this.imageCache.set(
                            frameId,
                            assets
                        );


                        this.loading.delete(
                            frameId
                        );


                        return assets;
                    }
                )
                .catch(
                    error => {

                        this.loading.delete(
                            frameId
                        );


                        console.error(
                            "[BUFFER] Frame failed:",
                            frameId,
                            error
                        );


                        const empty =
                            {};


                        for (
                            const cameraName
                            of CAMERA_NAMES
                        ) {

                            empty[
                                cameraName
                            ] =
                                {};
                        }


                        return empty;
                    }
                );


            this.loading.set(
                frameId,
                promise
            );


            return promise;
        }


        // =====================================================
        // Build list of frames that should be in the buffer
        // =====================================================

        getDesiredFrameIds() {

            const desired =
                new Set();


            for (
                let offset = 0;
                offset <
                ROLLING_WINDOW_FRAMES;
                offset++
            ) {

                const index =
                    this.rowIndex +
                    offset;


                const frameId =
                    this.getFrameId(
                        index
                    );


                if (frameId) {

                    desired.add(
                        frameId
                    );
                }
            }


            return desired;
        }


        // =====================================================
        // Load missing frames for rolling window
        // =====================================================

        async fillRollingWindow() {

            if (
                !this.running
            ) {

                return;
            }


            const desired =
                this.getDesiredFrameIds();


            const missing =
                [];


            // -------------------------------------------------
            // Find frames not already cached or loading.
            // -------------------------------------------------

            for (
                const frameId
                of desired
            ) {

                if (
                    !this.imageCache.has(
                        frameId
                    ) &&
                    !this.loading.has(
                        frameId
                    )
                ) {

                    missing.push(
                        frameId
                    );
                }
            }


            // -------------------------------------------------
            // Load missing frames in batches.
            // -------------------------------------------------

            for (
                let i = 0;
                i < missing.length;
                i += FRAME_LOAD_CONCURRENCY
            ) {

                if (
                    !this.running
                ) {

                    return;
                }


                const batch =
                    missing.slice(
                        i,
                        i +
                        FRAME_LOAD_CONCURRENCY
                    );


                await Promise.all(
                    batch.map(
                        frameId =>
                            this.loadFrame(
                                frameId
                            )
                    )
                );
            }


            // -------------------------------------------------
            // Evict frames outside the rolling window.
            // -------------------------------------------------

            for (
                const frameId
                of Array.from(
                    this.imageCache.keys()
                )
            ) {

                if (
                    !desired.has(
                        frameId
                    )
                ) {

                    this.imageCache.delete(
                        frameId
                    );
                }
            }


            console.log(
                "[BUFFER] Cache:",
                this.imageCache.size,
                "frames | current:",
                this.getFrameId(
                    this.rowIndex
                )
            );
        }


        // =====================================================
        // Background rolling loader
        // =====================================================

        async rollingLoader() {

            if (
                this.loaderRunning
            ) {

                return;
            }


            this.loaderRunning =
                true;


            console.log(
                "[BUFFER] Rolling loader started."
            );


            while (
                this.running
            ) {

                await this.fillRollingWindow();


                // Give the browser some breathing room.
                await new Promise(
                    resolve =>
                        setTimeout(
                            resolve,
                            20
                        )
                );
            }


            this.loaderRunning =
                false;


            console.log(
                "[BUFFER] Rolling loader stopped."
            );
        }


        // =====================================================
        // Initial buffer
        // =====================================================

        async preloadInitialWindow() {

            const count =
                Math.min(
                    ROLLING_WINDOW_FRAMES,
                    this.totalFrames
                );


            console.log(
                "========================================"
            );


            console.log(
                "[BUFFER] Preparing initial buffer"
            );


            console.log(
                "[BUFFER] Frames:",
                count
            );


            console.log(
                "[BUFFER] Images:",
                count *
                CAMERA_NAMES.length
            );


            console.log(
                "[BUFFER] Concurrency:",
                FRAME_LOAD_CONCURRENCY
            );


            console.log(
                "========================================"
            );


            const start =
                performance.now();


            for (
                let i = 0;
                i < count;
                i += FRAME_LOAD_CONCURRENCY
            ) {

                const batch =
                    [];


                for (
                    let j = i;
                    j < Math.min(
                        i +
                        FRAME_LOAD_CONCURRENCY,
                        count
                    );
                    j++
                ) {

                    const frameId =
                        this.getFrameId(
                            j
                        );


                    if (frameId) {

                        batch.push(
                            this.loadFrame(
                                frameId
                            )
                        );
                    }
                }


                await Promise.all(
                    batch
                );
            }


            const elapsed =
                performance.now() -
                start;


            console.log(
                "[BUFFER] Initial buffer ready in:",
                (elapsed / 1000).toFixed(2),
                "seconds"
            );


            console.log(
                "[BUFFER] Cache:",
                this.imageCache.size,
                "frames"
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


            const payload =
                this.preparePayload(
                    row
                );


            const frameId =
                payload.frame_id;


            const assets =
                this.imageCache.get(
                    frameId
                );


            // -------------------------------------------------
            // This should normally never happen.
            //
            // If it does, the producer has fallen behind.
            // -------------------------------------------------

            if (!assets) {

                console.warn(
                    "[REPLAY] Frame not ready:",
                    frameId,
                    "| Waiting for buffer..."
                );


                const loaded =
                    await this.loadFrame(
                        frameId
                    );


                if (!loaded) {

                    return;
                }
            }


            const readyAssets =
                this.imageCache.get(
                    frameId
                );


            if (!readyAssets) {

                console.error(
                    "[REPLAY] Could not obtain:",
                    frameId
                );


                return;
            }


            // -------------------------------------------------
            // Attach images.
            // -------------------------------------------------

            for (
                const cameraName
                of CAMERA_NAMES
            ) {

                Object.assign(
                    payload.cameras[
                        cameraName
                    ],
                    readyAssets[
                        cameraName
                    ] || {}
                );
            }


            // -------------------------------------------------
            // Reset trajectory at replay start.
            // -------------------------------------------------

            if (
                this.rowIndex === 0
            ) {

                payload.trajectory_reset =
                    true;
            }


            // -------------------------------------------------
            // Dashboard update.
            // -------------------------------------------------

            if (
                typeof window.updateDashboard !==
                "function"
            ) {

                throw new Error(
                    "window.updateDashboard() " +
                    "was not found."
                );
            }


            window.updateDashboard(
                payload
            );


            this.frameCount++;


            if (
                this.printEvery > 0 &&
                this.frameCount %
                    this.printEvery === 0
            ) {

                console.log(
                    "[REPLAY] Frame:",
                    this.frameCount,
                    "|",
                    frameId,
                    "| cache:",
                    this.imageCache.size
                );
            }


            // -------------------------------------------------
            // Advance replay.
            // -------------------------------------------------

            this.rowIndex++;


            // -------------------------------------------------
            // Full replay loop.
            // -------------------------------------------------

            if (
                this.rowIndex >=
                this.totalFrames
            ) {

                console.log(
                    "[REPLAY] Full replay complete."
                );


                this.rowIndex =
                    0;

                this.frameCount =
                    0;
            }
        }


        // =====================================================
        // Load CSV
        // =====================================================

        async loadCsv() {

            console.log(
                "[REPLAY] Loading CSV..."
            );


            const response =
                await fetch(
                    this.csvPath,
                    {
                        cache:
                            "no-store"
                    }
                );


            if (!response.ok) {

                throw new Error(
                    "CSV not found: " +
                    this.csvPath
                );
            }


            const text =
                await response.text();


            this.rows =
                this.parseCsv(
                    text
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
                "[REPLAY] CSV frames:",
                this.totalFrames
            );
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


            try {

                // -------------------------------------------------
                // Load CSV.
                // -------------------------------------------------

                await this.loadCsv();


                // -------------------------------------------------
                // Prepare first 20 frames.
                // -------------------------------------------------

                await this.preloadInitialWindow();


                // -------------------------------------------------
                // Tell dashboard replay is ready.
                // -------------------------------------------------

                if (
                    typeof window.updateDashboard ===
                    "function"
                ) {

                    window.updateDashboard({

                        trajectory_reset:
                            true,

                        replay_total_frames:
                            this.totalFrames
                    });
                }


                // -------------------------------------------------
                // Start background rolling loader.
                // -------------------------------------------------

                this.rollingLoader();


                // -------------------------------------------------
                // Start 10 FPS playback.
                // -------------------------------------------------

                const framePeriod =
                    1000 /
                    this.targetFps;


                console.log(
                    "[REPLAY] Starting playback at",
                    this.targetFps,
                    "FPS"
                );


                const loop =
                    async () => {

                        if (
                            !this.running
                        ) {

                            return;
                        }


                        const start =
                            performance.now();


                        try {

                            await this.publishFrame();

                        } catch (error) {

                            console.error(
                                "[REPLAY]",
                                error
                            );


                            this.stop();

                            return;
                        }


                        const elapsed =
                            performance.now() -
                            start;


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


            } catch (error) {

                console.error(
                    "[REPLAY] Startup failed:",
                    error
                );


                this.stop();
            }
        }


        // =====================================================
        // Stop
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


            this.loading.clear();


            this.imageCache.clear();


            console.log(
                "[REPLAY] Stopped."
            );
        }
    }


    // =========================================================
    // Global
    // =========================================================

    window.PerceptionReplay =
        PerceptionReplay;


    // =========================================================
    // Auto-start
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
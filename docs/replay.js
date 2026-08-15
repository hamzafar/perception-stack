/*
 * replay.js
 *
 * Native browser-image replay
 *
 * Architecture:
 *
 * CSV
 *  ↓
 * 10 FPS replay
 *  ↓
 * rolling camera cache
 *  ↓
 * new Image()
 *  ↓
 * img.decode()
 *  ↓
 * existing dashboard canvas
 *
 * No Web Workers.
 * No fetch() → Blob → createImageBitmap().
 *
 * Camera images remain normal HTMLImageElement objects,
 * allowing the browser to manage its native image cache.
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

    // Number of camera frames kept ready/in memory.
    //
    // 20 frames × 4 cameras = 80 images maximum.
    //
    // At 10 FPS:
    // 20 frames = 2 seconds.
    const ROLLING_WINDOW_FRAMES =
        20;

    // Number of complete frames loaded concurrently.
    //
    // 2 frames × 4 cameras = 8 image loads at once.
    const FRAME_LOAD_CONCURRENCY =
        2;


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

            this.rowIndex =
                0;

            this.frameCount =
                0;

            this.running =
                false;

            this.timer =
                null;

            // -------------------------------------------------
            // frameId -> {
            //     front: { bitmap: HTMLImageElement },
            //     rear:  { bitmap: HTMLImageElement },
            //     left:  { bitmap: HTMLImageElement },
            //     right: { bitmap: HTMLImageElement }
            // }
            // -------------------------------------------------

            this.imageCache =
                new Map();

            // frameId -> Promise
            //
            // Prevents duplicate image loading.
            this.loading =
                new Map();

            this.loaderRunning =
                false;
        }


        // =====================================================
        // Decode CSV values
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
        // Load ONE image using native browser image pipeline
        //
        // No fetch()
        // No Blob
        // No createImageBitmap()
        // =====================================================

        loadNativeImage(
            cameraName,
            frameId
        ) {

            return new Promise(
                (resolve, reject) => {

                    const image =
                        new Image();


                    // Allow browser to use its normal
                    // HTTP image cache.
                    image.decoding =
                        "async";


                    image.onload =
                        async () => {

                            try {

                                // Explicitly wait for the
                                // browser to finish decoding.
                                if (
                                    typeof image.decode ===
                                    "function"
                                ) {

                                    try {

                                        await image.decode();

                                    } catch (_) {

                                        // Some browsers may
                                        // report a decode error
                                        // after onload even though
                                        // the image is usable.
                                    }
                                }


                                resolve({

                                    // IMPORTANT:
                                    // Existing dashboard expects
                                    // cameraData.bitmap.
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
                                    "Image failed to load: " +
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

                        console.warn(
                            "[Replay] Image load failed:",
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

            // Already ready.
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


            // Already loading.
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


                        console.warn(
                            "[Replay] Failed:",
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
        // Release frame from our cache
        //
        // IMPORTANT:
        //
        // Native HTMLImageElement does not have bitmap.close().
        //
        // We release our reference by removing the cached
        // object. The browser owns its normal decoded-image
        // cache and can reclaim memory when appropriate.
        // =====================================================

        releaseFrame(
            frameId
        ) {

            this.imageCache.delete(
                frameId
            );
        }


        // =====================================================
        // Desired rolling window
        // =====================================================

        getDesiredWindow() {

            const desired =
                new Set();


            if (
                this.totalFrames <= 0
            ) {

                return desired;
            }


            for (
                let offset = 0;
                offset <
                ROLLING_WINDOW_FRAMES;
                offset++
            ) {

                const index =
                    (
                        this.rowIndex +
                        offset
                    ) %
                    this.totalFrames;


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
        // Maintain rolling buffer
        // =====================================================

        async maintainRollingWindow() {

            if (
                !this.running ||
                this.totalFrames <= 0
            ) {

                return;
            }


            const desired =
                this.getDesiredWindow();


            const missing =
                [];


            // -------------------------------------------------
            // Identify frames that need loading.
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
            // Load only a small number of complete frames
            // concurrently.
            // -------------------------------------------------

            for (
                let i = 0;
                i < missing.length;
                i += FRAME_LOAD_CONCURRENCY
            ) {

                if (!this.running) {

                    break;
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
            // Remove frames that have fallen outside the
            // rolling window.
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

                    this.releaseFrame(
                        frameId
                    );
                }
            }
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


            while (
                this.running
            ) {

                await this.maintainRollingWindow();


                await new Promise(
                    resolve =>
                        setTimeout(
                            resolve,
                            50
                        )
                );
            }


            this.loaderRunning =
                false;
        }


        // =====================================================
        // Publish one perception frame
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


            // -------------------------------------------------
            // Camera images should normally already be ready.
            // -------------------------------------------------

            let assets =
                this.imageCache.get(
                    frameId
                );


            // -------------------------------------------------
            // Safety fallback.
            //
            // If the rolling loader has not finished, load the
            // current frame.
            //
            // This should be rare after the initial buffer.
            // -------------------------------------------------

            if (!assets) {

                console.warn(
                    "[Replay] Frame not ready:",
                    frameId
                );


                assets =
                    await this.loadFrame(
                        frameId
                    );
            }


            // -------------------------------------------------
            // Attach images to dashboard payload.
            // -------------------------------------------------

            for (
                const cameraName
                of CAMERA_NAMES
            ) {

                Object.assign(
                    payload.cameras[
                        cameraName
                    ],
                    assets[
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
            // Update dashboard.
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
                    "[Replay] Published:",
                    this.frameCount,
                    "| frame:",
                    frameId,
                    "| cache:",
                    this.imageCache.size
                );
            }


            // -------------------------------------------------
            // Advance replay.
            // -------------------------------------------------

            this.rowIndex++;


            if (
                this.rowIndex >=
                this.totalFrames
            ) {

                console.log(
                    "[Replay] Replay complete."
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
                "[Replay] Loading CSV..."
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
                "[Replay] CSV loaded:",
                this.totalFrames,
                "frames"
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


            console.log(
                "[Replay] Starting..."
            );


            console.log(
                "[Replay] Target FPS:",
                this.targetFps
            );


            console.log(
                "[Replay] Rolling window:",
                ROLLING_WINDOW_FRAMES
            );


            console.log(
                "[Replay] Image loading concurrency:",
                FRAME_LOAD_CONCURRENCY
            );


            // -------------------------------------------------
            // Load CSV first.
            // -------------------------------------------------

            await this.loadCsv();


            // -------------------------------------------------
            // Reset replay.
            // -------------------------------------------------

            this.rowIndex =
                0;

            this.frameCount =
                0;


            // -------------------------------------------------
            // Initial camera buffer.
            //
            // With 20 frames:
            //
            // 20 × 4 = 80 images.
            //
            // Playback starts only after this initial buffer
            // is ready.
            // -------------------------------------------------

            console.log(
                "[Replay] Preparing initial camera buffer..."
            );


            await this.maintainRollingWindow();


            console.log(
                "[Replay] Initial camera buffer ready:",
                this.imageCache.size,
                "frames"
            );


            // -------------------------------------------------
            // Notify dashboard.
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
            // Start background loader.
            // -------------------------------------------------

            this.rollingLoader();


            // -------------------------------------------------
            // 10 FPS = 100 ms.
            // -------------------------------------------------

            const framePeriod =
                this.targetFps > 0
                    ? 1000 /
                      this.targetFps
                    : 0;


            // -------------------------------------------------
            // Replay loop.
            // -------------------------------------------------

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
                            "[Replay]",
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
                "[Replay] Stopped."
            );
        }
    }


    // =========================================================
    // Expose globally
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
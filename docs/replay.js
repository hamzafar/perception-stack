/*
 * replay.js
 *
 * FULL PRELOAD TEST
 *
 * Loads the first 100 perception frames completely
 * before starting playback.
 *
 * 100 frames
 * × 4 cameras
 * = 400 images
 *
 * The code measures:
 *
 *   1. Total preload time
 *   2. Average time per image
 *   3. Average time per frame
 *
 * Playback starts ONLY after all 100 frames are ready.
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
    // TEST SETTING
    //
    // Load 100 frames before playback.
    //
    // If CSV contains fewer than 100 frames,
    // all available frames are loaded.
    // ---------------------------------------------------------

    const PRELOAD_FRAMES =
        110;


    // ---------------------------------------------------------
    // Number of COMPLETE frames loaded concurrently.
    //
    // 2 frames × 4 cameras
    // = 8 image loads concurrently.
    // ---------------------------------------------------------

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

            this.preloadCount =
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
            // frameId -> camera assets
            // -------------------------------------------------

            this.imageCache =
                new Map();


            // -------------------------------------------------
            // Prevent duplicate loads.
            // -------------------------------------------------

            this.loading =
                new Map();
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

                                        // Image is already
                                        // loaded and usable.
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
                            "[PRELOAD] Failed:",
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
                            "[PRELOAD] Frame failed:",
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
        // PRELOAD ALL TEST FRAMES
        //
        // This is the important measurement.
        // =====================================================

        async preloadAll() {

            const count =
                Math.min(
                    PRELOAD_FRAMES,
                    this.totalFrames
                );


            this.preloadCount =
                count;


            const totalImages =
                count *
                CAMERA_NAMES.length;


            console.log(
                "========================================"
            );


            console.log(
                "[PRELOAD] Starting full preload"
            );


            console.log(
                "[PRELOAD] Frames:",
                count
            );


            console.log(
                "[PRELOAD] Cameras:",
                CAMERA_NAMES.length
            );


            console.log(
                "[PRELOAD] Total images:",
                totalImages
            );


            console.log(
                "[PRELOAD] Concurrency:",
                FRAME_LOAD_CONCURRENCY,
                "frames"
            );


            console.log(
                "[PRELOAD] Images concurrently:",
                FRAME_LOAD_CONCURRENCY *
                CAMERA_NAMES.length
            );


            console.log(
                "========================================"
            );


            const startTime =
                performance.now();


            let completed =
                0;


            for (
                let i = 0;
                i < count;
                i += FRAME_LOAD_CONCURRENCY
            ) {

                const batch =
                    [];


                for (
                    let j = i;
                    j <
                    Math.min(
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


                completed +=
                    batch.length;


                const elapsed =
                    performance.now() -
                    startTime;


                const seconds =
                    elapsed /
                    1000;


                const imagesDone =
                    completed *
                    CAMERA_NAMES.length;


                const avgImage =
                    imagesDone > 0
                        ? elapsed /
                          imagesDone
                        : 0;


                const avgFrame =
                    completed > 0
                        ? elapsed /
                          completed
                        : 0;


                console.log(
                    "[PRELOAD]",
                    completed +
                    "/" +
                    count,
                    "frames |",
                    imagesDone +
                    "/" +
                    totalImages,
                    "images |",
                    seconds.toFixed(2),
                    "s |",
                    "avg image:",
                    avgImage.toFixed(1),
                    "ms |",
                    "avg frame:",
                    avgFrame.toFixed(1),
                    "ms"
                );
            }


            const totalTime =
                performance.now() -
                startTime;


            const totalSeconds =
                totalTime /
                1000;


            const averageImageTime =
                totalImages > 0
                    ? totalTime /
                      totalImages
                    : 0;


            const averageFrameTime =
                count > 0
                    ? totalTime /
                      count
                    : 0;


            console.log(
                ""
            );


            console.log(
                "========================================"
            );


            console.log(
                "[PRELOAD] COMPLETE"
            );


            console.log(
                "========================================"
            );


            console.log(
                "Frames loaded:",
                count
            );


            console.log(
                "Images loaded:",
                totalImages
            );


            console.log(
                "Total preload time:",
                totalSeconds.toFixed(2),
                "seconds"
            );


            console.log(
                "Average per image:",
                averageImageTime.toFixed(2),
                "ms"
            );


            console.log(
                "Average per frame:",
                averageFrameTime.toFixed(2),
                "ms"
            );


            console.log(
                "Cache size:",
                this.imageCache.size,
                "frames"
            );


            console.log(
                "========================================"
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


            if (!assets) {

                console.error(
                    "[REPLAY] Missing preloaded frame:",
                    frameId
                );


                return;
            }


            // -------------------------------------------------
            // Attach preloaded images.
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
            // Trajectory reset.
            // -------------------------------------------------

            if (
                this.rowIndex === 0
            ) {

                payload.trajectory_reset =
                    true;
            }


            // -------------------------------------------------
            // Dashboard.
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
                    frameId
                );
            }


            this.rowIndex++;


            // -------------------------------------------------
            // Loop after the preloaded 100 frames.
            // -------------------------------------------------

            if (
                this.rowIndex >=
                this.preloadCount
            ) {

                console.log(
                    "[REPLAY] 100-frame loop complete."
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
                // Load CSV
                // -------------------------------------------------

                await this.loadCsv();


                // -------------------------------------------------
                // Preload 100 frames
                // -------------------------------------------------

                await this.preloadAll();


                // -------------------------------------------------
                // Tell dashboard that replay is ready.
                // -------------------------------------------------

                if (
                    typeof window.updateDashboard ===
                    "function"
                ) {

                    window.updateDashboard({

                        trajectory_reset:
                            true,

                        replay_total_frames:
                            this.preloadCount
                    });
                }


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
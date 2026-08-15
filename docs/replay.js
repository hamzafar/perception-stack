/*
 * replay.js
 *
 * Rolling decoded-image buffer
 *
 * 10 FPS replay
 * 20-frame rolling camera window
 * 4 cameras
 *
 * Playback does NOT fetch/decode the current frame.
 * Camera images are decoded ahead of playback and kept in memory.
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

    // Number of decoded frames kept in memory.
    //
    // 20 frames × 4 cameras = 80 ImageBitmaps maximum.
    //
    // At 10 FPS:
    // 20 frames = 2 seconds of camera buffer.
    const ROLLING_WINDOW_FRAMES = 100;

    // Number of frames loaded simultaneously.
    // Keep this modest to avoid browser/network bursts.
    const FRAME_LOAD_CONCURRENCY = 4;


    // =========================================================
    // PerceptionReplay
    // =========================================================

    class PerceptionReplay {

        constructor() {

            this.csvPath = CSV_PATH;
            this.datasetPath = DATASET_PATH;

            this.targetFps = TARGET_FPS;
            this.printEvery = PRINT_EVERY;

            this.rows = [];
            this.totalFrames = 0;

            this.rowIndex = 0;
            this.frameCount = 0;

            this.running = false;
            this.timer = null;

            // -------------------------------------------------
            // frameId -> {
            //     front: { bitmap },
            //     rear:  { bitmap },
            //     left:  { bitmap },
            //     right: { bitmap }
            // }
            // -------------------------------------------------

            this.imageCache = new Map();

            // Frames currently being loaded.
            //
            // frameId -> Promise
            //
            // Prevents duplicate loading of the same frame.
            this.loading = new Map();

            this.rollingLoaderRunning = false;
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

                const ch = text[i];

                if (quoted) {

                    if (ch === '"') {

                        if (text[i + 1] === '"') {

                            field += '"';
                            i++;

                        } else {

                            quoted = false;
                        }

                    } else {

                        field += ch;
                    }

                    continue;
                }

                if (ch === '"') {

                    quoted = true;

                } else if (ch === ",") {

                    row.push(field);
                    field = "";

                } else if (ch === "\n") {

                    row.push(field);
                    rows.push(row);

                    row = [];
                    field = "";

                } else if (ch !== "\r") {

                    field += ch;
                }
            }

            if (
                field.length > 0 ||
                row.length > 0
            ) {

                row.push(field);
                rows.push(row);
            }

            if (rows.length === 0) {
                return [];
            }

            const headers = rows[0];

            return rows
                .slice(1)
                .filter(values =>
                    values.some(value => value !== "")
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
        // =====================================================

        preparePayload(row) {

            const payload = {};

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
                    String(Number(frameIdx))
                        .padStart(6, "0");

                payload.frame_id =
                    frameId;
            }


            // -------------------------------------------------
            // Frame index
            // -------------------------------------------------

            if (
                payload.frame_idx === undefined
            ) {

                const match =
                    String(frameId)
                        .match(/(\d+)$/);

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
                    !Array.isArray(cameraData.boxes)
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
        // Get frame ID from CSV row
        // =====================================================

        getFrameId(index) {

            if (
                this.totalFrames <= 0
            ) {
                return null;
            }

            index =
                ((index % this.totalFrames)
                + this.totalFrames)
                % this.totalFrames;

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
                return String(frameId);
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
                String(Number(frameIdx))
                    .padStart(6, "0")
            );
        }


        // =====================================================
        // Load one camera
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
                await fetch(imagePath);

            if (!response.ok) {

                throw new Error(
                    "Image not found: " +
                    imagePath
                );
            }

            const blob =
                await response.blob();


            if (
                typeof createImageBitmap !==
                "function"
            ) {

                throw new Error(
                    "createImageBitmap() " +
                    "is required."
                );
            }


            // Decode near the actual dashboard size.
            const resizeHeight =
                cameraName === "front"
                    ? 560
                    : 220;


            const bitmap =
                await createImageBitmap(
                    blob,
                    {
                        resizeHeight:
                            resizeHeight
                    }
                );


            return {
                bitmap: bitmap
            };
        }


        // =====================================================
        // Load all 4 cameras for one frame
        // =====================================================

        async loadFrameAssets(frameId) {

            const results =
                await Promise.allSettled(

                    CAMERA_NAMES.map(
                        cameraName =>
                            this.loadCameraAsset(
                                cameraName,
                                frameId
                            )
                    )
                );


            const assets = {};

            results.forEach(
                (result, index) => {

                    const cameraName =
                        CAMERA_NAMES[index];

                    if (
                        result.status ===
                        "fulfilled"
                    ) {

                        assets[cameraName] =
                            result.value;

                    } else {

                        console.warn(
                            "[Replay] Camera load failed:",
                            cameraName,
                            frameId,
                            result.reason
                        );

                        assets[cameraName] =
                            {};
                    }
                }
            );


            return assets;
        }


        // =====================================================
        // Load frame into rolling memory
        //
        // Duplicate requests are prevented using this.loading.
        // =====================================================

        loadFrame(frameId) {

            if (
                this.imageCache.has(frameId)
            ) {

                return Promise.resolve(
                    this.imageCache.get(frameId)
                );
            }


            if (
                this.loading.has(frameId)
            ) {

                return this.loading.get(frameId);
            }


            const promise =
                this.loadFrameAssets(frameId)
                    .then(assets => {

                        this.imageCache.set(
                            frameId,
                            assets
                        );

                        this.loading.delete(
                            frameId
                        );

                        return assets;
                    })
                    .catch(error => {

                        this.loading.delete(
                            frameId
                        );

                        console.warn(
                            "[Replay] Failed loading:",
                            frameId,
                            error
                        );

                        // Keep playback alive.
                        const empty = {};

                        for (
                            const cameraName
                            of CAMERA_NAMES
                        ) {

                            empty[cameraName] = {};
                        }

                        return empty;
                    });


            this.loading.set(
                frameId,
                promise
            );


            return promise;
        }


        // =====================================================
        // Release one decoded frame
        // =====================================================

        releaseFrame(frameId) {

            const assets =
                this.imageCache.get(
                    frameId
                );

            if (!assets) {
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
                    assets[cameraName];

                if (
                    asset &&
                    asset.bitmap &&
                    typeof asset.bitmap.close ===
                    "function"
                ) {

                    asset.bitmap.close();
                }
            }
        }


        // =====================================================
        // Determine which frames should remain in memory
        //
        // The window is:
        //
        // current frame
        // +
        // next 19 frames
        //
        // Example:
        //
        // current = 100
        //
        // memory:
        // 100 ... 119
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
                offset < ROLLING_WINDOW_FRAMES;
                offset++
            ) {

                const index =
                    (
                        this.rowIndex +
                        offset
                    ) %
                    this.totalFrames;

                const frameId =
                    this.getFrameId(index);

                if (frameId) {
                    desired.add(frameId);
                }
            }

            return desired;
        }


        // =====================================================
        // Maintain rolling window
        //
        // This function:
        //
        // 1. Loads missing future frames.
        // 2. Keeps current/future frames.
        // 3. Releases old frames.
        //
        // Concurrency is limited.
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


            // -------------------------------------------------
            // Find frames that are needed but not loaded.
            // -------------------------------------------------

            const missing = [];

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

                    missing.push(frameId);
                }
            }


            // -------------------------------------------------
            // Load missing frames in small batches.
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
            // Release frames outside the rolling window.
            // -------------------------------------------------

            for (
                const frameId
                of Array.from(
                    this.imageCache.keys()
                )
            ) {

                if (
                    !desired.has(frameId)
                ) {

                    this.releaseFrame(
                        frameId
                    );
                }
            }
        }


        // =====================================================
        // Background rolling-window worker
        //
        // Runs continuously but does NOT render anything.
        // =====================================================

        async rollingLoader() {

            if (
                this.rollingLoaderRunning
            ) {

                return;
            }

            this.rollingLoaderRunning =
                true;


            while (
                this.running
            ) {

                await this.maintainRollingWindow();


                // Small pause before checking the
                // new playback position.
                await new Promise(
                    resolve =>
                        setTimeout(
                            resolve,
                            20
                        )
                );
            }


            this.rollingLoaderRunning =
                false;
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


            // -------------------------------------------------
            // Get decoded camera images.
            //
            // Normally this should already exist in memory.
            //
            // If it doesn't, wait for the loader.
            // -------------------------------------------------

            let assets =
                this.imageCache.get(
                    frameId
                );


            if (!assets) {

                console.warn(
                    "[Replay] Frame not ready:",
                    frameId,
                    "Waiting for decode..."
                );


                assets =
                    await this.loadFrame(
                        frameId
                    );
            }


            // -------------------------------------------------
            // Attach decoded images.
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
            // Dashboard update
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
                    "[Replay] Published",
                    this.frameCount,
                    "frames",
                    "(" +
                    frameId +
                    ")",
                    "| cache:",
                    this.imageCache.size,
                    "frames"
                );
            }


            // -------------------------------------------------
            // Advance
            // -------------------------------------------------

            this.rowIndex++;


            if (
                this.rowIndex >=
                this.totalFrames
            ) {

                console.log(
                    "[Replay] Replay complete:",
                    this.frameCount,
                    "frames"
                );

                this.rowIndex = 0;
                this.frameCount = 0;
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
                "[Replay] Starting..."
            );

            console.log(
                "[Replay] Target FPS:",
                this.targetFps
            );

            console.log(
                "[Replay] Rolling window:",
                ROLLING_WINDOW_FRAMES,
                "frames"
            );

            console.log(
                "[Replay] Camera memory:",
                ROLLING_WINDOW_FRAMES *
                CAMERA_NAMES.length,
                "ImageBitmaps maximum"
            );


            // -------------------------------------------------
            // Load CSV
            // -------------------------------------------------

            await this.loadCsv();


            // -------------------------------------------------
            // Reset
            // -------------------------------------------------

            this.rowIndex = 0;
            this.frameCount = 0;


            // -------------------------------------------------
            // Initial window
            //
            // We intentionally wait until the first rolling
            // window is decoded before playback starts.
            //
            // This prevents the first several frames from
            // competing with playback for image decoding.
            // -------------------------------------------------

            console.log(
                "[Replay] Preloading first",
                ROLLING_WINDOW_FRAMES,
                "frames..."
            );


            await this.maintainRollingWindow();


            console.log(
                "[Replay] Initial camera buffer ready."
            );


            // -------------------------------------------------
            // Tell dashboard dataset size.
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
            // Start rolling background loader.
            // -------------------------------------------------

            this.rollingLoader();


            // -------------------------------------------------
            // 10 FPS = 100 ms/frame
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
        // Load CSV
        // =====================================================

        async loadCsv() {

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
                "[Replay] CSV loaded:",
                this.totalFrames,
                "frames"
            );
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


            // -------------------------------------------------
            // Release every decoded ImageBitmap.
            // -------------------------------------------------

            for (
                const frameId
                of Array.from(
                    this.imageCache.keys()
                )
            ) {

                this.releaseFrame(
                    frameId
                );
            }


            this.imageCache.clear();


            console.log(
                "[Replay] Stopped."
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
        function () {

            const replay =
                new PerceptionReplay();

            window.perceptionReplay =
                replay;

            replay.replay();
        }
    );

})();